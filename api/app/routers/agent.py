"""Phase 4 — LangChain banking agent (ReAct-based).

POST /agent/query     — authenticated banking agent with full tool access
POST /agent/frontdesk — spoken lobby turn: CQR → auth → ReAct agent → natural reply
"""
from __future__ import annotations

import logging
import re
import time
from functools import wraps
from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from langsmith import traceable
from pydantic import BaseModel
from supabase import Client

from ..config import settings
from ..deps import get_current_user_id, get_supabase

log = logging.getLogger("bankbot.agent")
router = APIRouter(prefix="/agent", tags=["agent"])


# ── Latency timer ─────────────────────────────────────────────────────────────

class _Timer:
    def __init__(self) -> None:
        self._t0 = time.time()
        self._marks: dict[str, int] = {}

    def mark(self, name: str) -> None:
        self._marks[name] = round((time.time() - self._t0) * 1000)

    def log(self, logger: logging.Logger, prefix: str = "") -> None:
        parts = "  ".join(f"{k}={v}ms" for k, v in self._marks.items())
        total = round((time.time() - self._t0) * 1000)
        logger.info("⏱  %s  %s  total=%dms", prefix, parts, total)


# ── Request / Response ────────────────────────────────────────────────────────

class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: str


class QueryRequest(BaseModel):
    question: str
    robot_name: str = "ARIA"
    history: list[ChatTurn] = []


class QueryResponse(BaseModel):
    answer: str
    rewritten_query: str | None = None


class DeskMessage(BaseModel):
    role: Literal["agent", "visitor"]
    text: str


class FrontDeskRequest(BaseModel):
    utterance: str
    robot_name: str = "ARIA"
    recognised_name: str | None = None
    user_id: str | None = None
    has_face_match: bool = False
    has_magic_link: bool = False
    pin_verified: bool = False
    history: list[DeskMessage] = []
    clarification_count: int = 0
    auth_state: Literal["none", "face_matched", "confirmed"] = "none"
    customer_type: Literal["unknown", "existing", "new"] = "unknown"
    pending_query: str | None = None  # query buffered before auth completed


class FrontDeskResponse(BaseModel):
    summary: str
    reply: str
    intent: str = "general"
    should_route: bool = False
    route_target: Literal["none", "signup", "login", "magic_link"] = "none"
    confidence: float = 0.0
    risk_level: Literal["low", "medium", "high"] = "low"
    escalate: bool = False
    clarification_count: int = 0
    intent_module: str = "general"
    pin_verified: bool = False


# ── Banking tools ─────────────────────────────────────────────────────────────

def _make_tools(user_id: str, sb: Client, *, can_execute: bool = False):
    """Return banking tools for a user.

    Read tools are always available. Action tools (transfer, pay credit card)
    are only included when can_execute=True (i.e. PIN-verified).
    """

    @tool
    def get_profile(_: str = "") -> str:
        """Return the customer's personal profile: full name, address, date of
        birth, when they joined, whether Face ID is set up."""
        res = sb.table("accounts").select("*").eq("user_id", user_id).maybe_single().execute()
        if not res.data:
            return "Account not found."
        d = res.data
        face = "Yes" if d.get("face_image_path") else "No"
        return (
            f"Name: {d['first_name']} {d['last_name']}\n"
            f"Address: {d.get('address') or 'Not on file'}\n"
            f"Date of birth: {d.get('date_of_birth') or 'Not on file'}\n"
            f"Member since: {d['created_at'][:10]}\n"
            f"Face ID: {face}"
        )

    @tool
    def get_account_summary(_: str = "") -> str:
        """Return a complete overview: all balances, credit info, net position."""
        res = sb.table("accounts").select("*").eq("user_id", user_id).maybe_single().execute()
        if not res.data:
            return "Account not found."
        d = res.data
        chq = float(d["chequing_balance"])
        sav = float(d["savings_balance"])
        cred = float(d["credit_balance"])
        lim = float(d["credit_limit"])
        avail = lim - cred
        return (
            f"Customer: {d['first_name']}\n"
            f"Chequing: ${chq:,.2f}  |  Savings: ${sav:,.2f}\n"
            f"Credit card: ${cred:,.2f} of ${lim:,.2f} limit (${avail:,.2f} available)\n"
            f"Net position: ${chq + sav - cred:,.2f}\n"
            f"Credit score: {d.get('credit_score') or 'not recorded on this account'}"
        )

    @tool
    def get_balance(account_type: str = "all") -> str:
        """Return a specific balance. account_type: 'chequing', 'savings',
        'credit', or 'all'."""
        res = sb.table("accounts").select("*").eq("user_id", user_id).maybe_single().execute()
        if not res.data:
            return "Account not found."
        d = res.data
        chq = float(d["chequing_balance"])
        sav = float(d["savings_balance"])
        cred = float(d["credit_balance"])
        lim = float(d["credit_limit"])
        t = account_type.lower().strip()
        if "chequ" in t or "check" in t or "current" in t:
            return f"Chequing balance: ${chq:,.2f}"
        if "sav" in t:
            return f"Savings balance: ${sav:,.2f}"
        if "cred" in t or "card" in t:
            return f"Credit card: ${cred:,.2f} owing of ${lim:,.2f} limit; ${lim-cred:,.2f} available."
        return f"Chequing ${chq:,.2f} · Savings ${sav:,.2f} · Credit used ${cred:,.2f} of ${lim:,.2f}"

    @tool
    def get_credit_info(_: str = "") -> str:
        """Return credit score, utilisation ratio, and available credit."""
        res = sb.table("accounts").select("*").eq("user_id", user_id).maybe_single().execute()
        if not res.data:
            return "Account not found."
        d = res.data
        used = float(d["credit_balance"] or 0)
        limit = float(d["credit_limit"] or 0)
        util = f"{used/limit*100:.1f}%" if limit > 0 else "N/A"
        score = d.get("credit_score")
        score_str = str(score) if score else "not recorded on this account"
        return (
            f"Credit score: {score_str}\n"
            f"Balance: ${used:,.2f} of ${limit:,.2f} limit\n"
            f"Utilisation: {util}\n"
            f"Available credit: ${limit - used:,.2f}"
        )

    @tool
    def get_recent_transactions(limit: str = "10") -> str:
        """Return the customer's most recent transactions (expenses)."""
        try:
            n = max(1, min(int(limit), 50))
        except ValueError:
            n = 10
        res = (
            sb.table("expenses")
            .select("category,amount,occurred_at")
            .eq("user_id", user_id)
            .order("occurred_at", desc=True)
            .limit(n)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return "No recent transactions found."
        lines = "\n".join(
            f"{r['occurred_at']} · {r['category']} · ${float(r['amount']):,.2f}" for r in rows
        )
        return f"Last {len(rows)} transactions:\n{lines}"

    @tool
    def get_expenses(months: str = "3") -> str:
        """Return spending grouped by category for the last N months."""
        from datetime import date, timedelta
        try:
            m = max(1, min(int(months), 24))
        except ValueError:
            m = 3
        since = (date.today() - timedelta(days=31 * m)).isoformat()
        res = (
            sb.table("expenses")
            .select("category,amount")
            .eq("user_id", user_id)
            .gte("occurred_at", since)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return f"No expenses in the last {m} month(s)."
        totals: dict[str, float] = {}
        for r in rows:
            totals[r["category"]] = totals.get(r["category"], 0) + float(r["amount"])
        lines = "\n".join(f"{cat}: ${amt:,.2f}" for cat, amt in sorted(totals.items(), key=lambda x: -x[1]))
        total = sum(totals.values())
        return f"Spending last {m} month(s):\n{lines}\nTotal: ${total:,.2f}"

    read_tools = [
        get_profile,
        get_account_summary,
        get_balance,
        get_credit_info,
        get_recent_transactions,
        get_expenses,
    ]

    if not can_execute:
        return read_tools

    @tool
    def transfer_between_accounts(direction: str, amount: str) -> str:
        """Move money between chequing and savings accounts.
        direction: 'chequing_to_savings' or 'savings_to_chequing'.
        amount: dollar amount (e.g. '300')."""
        try:
            amt = round(float(amount), 2)
            if amt <= 0:
                return "Amount must be positive."
        except ValueError:
            return f"Invalid amount: {amount}"
        res = sb.table("accounts").select("chequing_balance,savings_balance").eq("user_id", user_id).maybe_single().execute()
        if not res.data:
            return "Account not found."
        chq = float(res.data["chequing_balance"])
        sav = float(res.data["savings_balance"])
        d = direction.lower().strip()
        if d == "chequing_to_savings":
            if amt > chq:
                return f"Insufficient funds. Chequing balance is ${chq:,.2f}."
            new_chq, new_sav = chq - amt, sav + amt
            label = "chequing to savings"
        elif d == "savings_to_chequing":
            if amt > sav:
                return f"Insufficient funds. Savings balance is ${sav:,.2f}."
            new_chq, new_sav = chq + amt, sav - amt
            label = "savings to chequing"
        else:
            return "Invalid direction. Use 'chequing_to_savings' or 'savings_to_chequing'."
        sb.table("accounts").update({"chequing_balance": new_chq, "savings_balance": new_sav}).eq("user_id", user_id).execute()
        return (
            f"Transfer complete: ${amt:,.2f} moved {label}. "
            f"New chequing: ${new_chq:,.2f}, savings: ${new_sav:,.2f}."
        )

    @tool
    def pay_credit_card(amount: str) -> str:
        """Pay toward the credit card balance from chequing.
        amount: dollars (e.g. '200') or 'full'."""
        res = sb.table("accounts").select("chequing_balance,credit_balance").eq("user_id", user_id).maybe_single().execute()
        if not res.data:
            return "Account not found."
        chq = float(res.data["chequing_balance"])
        cred = float(res.data["credit_balance"])
        if cred <= 0:
            return "Your credit card has no outstanding balance."
        if amount.lower().strip() == "full":
            amt = cred
        else:
            try:
                amt = round(float(amount), 2)
                if amt <= 0:
                    return "Amount must be positive."
            except ValueError:
                return f"Invalid amount: {amount}"
        if amt > cred:
            amt = cred
        if amt > chq:
            return f"Insufficient chequing funds (${chq:,.2f}) to pay ${amt:,.2f}."
        new_chq, new_cred = chq - amt, cred - amt
        sb.table("accounts").update({"chequing_balance": new_chq, "credit_balance": new_cred}).eq("user_id", user_id).execute()
        return f"Paid ${amt:,.2f}. New chequing: ${new_chq:,.2f}, credit owing: ${new_cred:,.2f}."

    return read_tools + [transfer_between_accounts, pay_credit_card]


# ── Prompts ───────────────────────────────────────────────────────────────────

_MASTER_PROMPT = """
SYSTEM ROLE
You are a calm, professional bank teller at BankBot Vision. You speak face-to-face with customers. Every word you say is spoken aloud.

PRIMARY GOAL
Help the customer complete one banking task per turn. Be specific, brief, and human.

VOICE STYLE
- 1–2 short spoken sentences per turn. Natural English only.
- Speak numbers as words: "twelve hundred dollars" not "$1,200.00".
- One question per turn. Never list more than two options.
- Never read raw data tables, bullet points, or system output verbatim.
- Sound calm, warm, and confident. Never robotic.

BANKING CONVERSATION FLOW (follow every turn):
  1. RESTATE — for action intents, say what you understood in one phrase:
       "You want to move three hundred dollars from chequing to savings — is that right?"
  2. CONFIRM — before any money movement or sensitive change, wait for "yes".
  3. EXECUTE — call the right tool. Never invent numbers.
  4. REPORT — one short confirmation sentence: "Done. Transfer complete."
  5. NEXT — offer ONE relevant follow-up, not a menu.

TOOL USE
- When the customer asks about ANY balance (chequing, savings, credit), CALL get_balance with the right account_type. Do not guess.
- When the customer asks about credit score or credit limit, CALL get_credit_info. Do not guess.
- When the customer asks for a full overview or summary, CALL get_account_summary.
- When the customer asks about transactions or spending, CALL get_recent_transactions or get_expenses.
- When the customer confirms a pending action (says "yes"/"go ahead"), CALL the action tool.
- Never say "I don't have access to that" — if a tool exists for it, use it immediately.
- If a tool returns "not recorded on this account", tell the customer that field hasn't been set up yet and they can add it in account settings.
- If no tool applies, answer from general banking knowledge in one sentence.

SCRIPT PATTERNS (use as natural templates):
  Balance inquiry : "Your chequing balance is [amount]. Want to see savings too?"
  Transfer intent : "You want to move [amount] from [source] to [destination] — shall I do that?"
  Transfer done   : "Done. [amount] moved. Your new chequing balance is [amount]."
  PIN challenge   : "To confirm that, please say your four-digit PIN."
  PIN wrong       : "That PIN doesn't match. Please try again."
  Low confidence  : "I want to make sure I understand — did you mean [option A] or [option B]?"
  Escalate        : "This one's better handled by a specialist. Want me to connect you?"
  No data on file : "Your [field] hasn't been recorded yet. You can update it in your account settings — anything else I can help with?"
  Out of scope    : "That's a bit outside what I can do here. I can help with balances, spending, or transfers — what would you like?"

DO NOT
- Ask for SSN, SIN, or any government ID. We do not store these.
- Invent balances, transactions, or account fields that were not returned by a tool.
- Mention tool names, API calls, or internal system labels.
- Give more than one question or two options per turn.
- Repeat "I want to make sure I understand — can you say that another way?" as a default. Only ask for a repeat if the transcript is genuinely unreadable.
"""

_ROBOT_SYSTEM: dict[str, str] = {
    "ARIA": "You are ARIA, a professional and warm bank teller. " + _MASTER_PROMPT,
    "MAX":  "You are MAX, a fast and precise bank teller. Direct answers, short sentences, confident tone. " + _MASTER_PROMPT,
    "ZED":  "You are ZED, a calm and analytical banking advisor. Measured, thoughtful, helpful. " + _MASTER_PROMPT,
}
DEFAULT_SYSTEM = _ROBOT_SYSTEM["ARIA"]


# ── Intent classification (keyword-based, no LLM call) ────────────────────────

_INTENT_KEYWORDS: list[tuple[str, str, tuple[str, ...]]] = [
    # (intent, risk, keywords)
    ("fraud_dispute",         "high",   ("fraud", "suspicious", "don't recognize", "didn't make",
                                          "unauthorized", "dispute", "scam", "not mine")),
    ("card_services",         "high",   ("lost card", "stolen card", "block card", "freeze card",
                                          "cancel card", "replace card", "change pin", "travel notice")),
    ("transfer_money",        "high",   ("transfer", "move money", "send money", "pay bill",
                                          "pay my", "chequing to savings", "savings to chequing",
                                          "move from", "move to", "pay credit card", "pay off")),
    ("account_overview",      "medium", ("balance", "summary", "overview", "how much",
                                          "credit score", "available credit", "net worth", "net position",
                                          "my savings", "savings account", "savings balance", "my saving",
                                          "my chequing", "chequing balance", "checking balance",
                                          "my account", "credit limit", "credit available")),
    ("recent_transactions",   "medium", ("transactions", "spending", "expenses", "spent",
                                          "last few", "recent", "statement", "what did i spend",
                                          "where did my money go", "breakdown")),
    ("login_access_help",     "medium", ("can't log in", "locked out", "forgot password",
                                          "reset password", "otp", "verification code", "login help")),
    ("new_account_opening",   "low",    ("open account", "new account", "sign up", "become customer",
                                          "first time", "join", "register", "apply", "start an account")),
    ("product_recommendation","low",    ("which account", "best account", "compare", "recommend",
                                          "cashback", "travel card", "mortgage rate", "loan rate",
                                          "interest rate", "savings rate")),
    ("branch_appointment",    "low",    ("branch", "location", "nearest", "in person",
                                          "appointment", "human", "specialist", "advisor", "speak to")),
    ("public_info",           "low",    ("hours", "about your bank", "how does", "what is",
                                          "tell me about", "your services")),
    ("greeting",              "low",    ("hello", "hi there", "hey there", "good morning",
                                          "good afternoon", "what's up")),
]


def _classify_intent(text: str) -> tuple[str, str]:
    """Keyword-based intent classification. Returns (intent, risk_level)."""
    lower = text.lower()
    for intent, risk, keywords in _INTENT_KEYWORDS:
        if any(k in lower for k in keywords):
            return intent, risk
    return "unknown", "low"


# ── PIN extraction and verification ──────────────────────────────────────────

_WORD_TO_DIGIT: dict[str, str] = {
    "zero": "0", "oh": "0", "o": "0",
    "one": "1", "won": "1",
    "two": "2", "to": "2", "too": "2",
    "three": "3", "tree": "3",
    "four": "4", "for": "4", "fore": "4",
    "five": "5",
    "six": "6", "sex": "6",
    "seven": "7",
    "eight": "8", "ate": "8",
    "nine": "9", "nein": "9",
}


def _normalize_pin(text: str) -> str:
    """Convert any Whisper output of a spoken PIN into a plain digit string.

    Handles:
      "2 2 2 4"           → "2224"
      "2, 2, 2, 4"        → "2224"
      "two two two four"  → "2224"
      "2224"              → "2224"
      "two-two-two-four"  → "2224"
    """
    cleaned = text.lower().replace(",", " ").replace("-", " ").replace(".", " ")
    digits: list[str] = []
    for token in cleaned.split():
        if token.isdigit():
            digits.extend(list(token))          # "2224" → ["2","2","2","4"]
        elif token in _WORD_TO_DIGIT:
            digits.append(_WORD_TO_DIGIT[token])
    return "".join(digits)


def _extract_pin(text: str, llm: ChatOpenAI) -> str | None:
    """Extract a 4-digit PIN from a Whisper transcript.

    1. Fast deterministic normalizer — covers 95 % of Whisper variants.
    2. LLM fallback — catches compound numbers ("twenty-two twenty-four").
    Returns None if neither pass produces exactly 4 digits.
    """
    # Pass 1: deterministic (zero latency)
    normalized = _normalize_pin(text)
    if len(normalized) == 4 and normalized.isdigit():
        log.info("   🔢 PIN normalizer: %r → %s", text[:40], normalized)
        return normalized

    # Pass 2: LLM fallback for compound / unusual spoken forms
    _PIN_PROMPT = (
        "The user said their 4-digit bank PIN. "
        "Whisper ASR may use words, digits, commas, or compound numbers. "
        "Extract exactly 4 digits. "
        "Return ONLY the 4 digits (e.g. 2224). If impossible, return NONE."
    )
    try:
        result = llm.invoke([
            SystemMessage(content=_PIN_PROMPT),
            HumanMessage(content=f'Transcript: "{text}"'),
        ])
        raw = (result.content or "").strip().replace(" ", "").replace(",", "").replace("-", "")
        if raw.isdigit() and len(raw) == 4:
            log.info("   🔢 LLM PIN fallback: %r → %s", text[:40], raw)
            return raw
    except Exception as e:
        log.warning("PIN LLM fallback failed: %s", e)

    log.info("   🔢 PIN extraction failed for: %r", text[:40])
    return None


def _verify_pin_db(sb: Client, user_id: str, candidate: str) -> str:
    """Check candidate PIN against the database.

    Returns:
        "ok"       — PIN matches
        "no_pin"   — no PIN set in the account
        "mismatch" — PIN set but does not match
        "error"    — DB lookup failed
    """
    try:
        res = sb.table("accounts").select("pin").eq("user_id", user_id).maybe_single().execute()
        stored = (res.data or {}).get("pin")
        if not stored:
            log.info("   ⚠️  No PIN stored for user")
            return "no_pin"
        match = stored.strip() == candidate.strip()
        log.info("   🔐 PIN compare: %s", "match" if match else "mismatch")
        return "ok" if match else "mismatch"
    except Exception as e:
        log.warning("PIN DB lookup failed: %s", e)
        return "error"


# ── Contextual Query Rewriting (fixes Whisper errors) ────────────────────────

_CQR_PROMPT = """You are a speech cleanup module at a bank teller kiosk.
The transcript was produced by Whisper ASR and may contain errors, filler words, or fragments.

Common ASR errors to fix:
- "checking" often means "chequing"
- garbled phrases ("gonna get too old") often mean the visitor trailed off — return as-is
- resolve pronouns using conversation history ("the other one" → "savings account")

Rules:
1. Return ONE clean sentence matching the visitor's true intent.
2. Do NOT invent new requests — only rewrite what they actually said.
3. If the input is already clear, return it unchanged.
4. If the input is genuinely unreadable, return it unchanged (do not guess).
5. Output only the cleaned sentence. No preamble, no explanation.
"""


@traceable(name="CQR Compression", run_type="llm", tags=["cqr"])
def _compress_utterance(text: str, history: list[DeskMessage], llm: ChatOpenAI) -> str:
    """Clean up Whisper ASR errors and resolve context. Skip for short utterances."""
    words = text.split()
    if len(words) <= 6:
        return text
    history_text = "\n".join(f"{m.role.upper()}: {m.text}" for m in history[-4:]) or "First turn."
    try:
        result = llm.invoke(
            [
                SystemMessage(content=_CQR_PROMPT),
                HumanMessage(
                    content=(
                        f"Recent conversation:\n{history_text}\n\n"
                        f"Visitor said:\n\"{text}\"\n\n"
                        f"Cleaned sentence:"
                    )
                ),
            ],
            config={"run_name": f"CQR: {text[:40]}"},
        )
        cleaned = (result.content or "").strip().strip('"').strip()
        if cleaned and len(cleaned) < len(text) * 2:
            return cleaned
    except Exception as e:
        log.warning("CQR failed: %s", e)
    return text


# ── Auth challenge / PIN mismatch replies (deterministic, no LLM) ────────────

def _auth_challenge_reply(intent: str, payload: FrontDeskRequest) -> FrontDeskResponse:
    name_part = f", {payload.recognised_name}" if payload.recognised_name else ""
    if payload.has_face_match:
        reply = (
            f"To do that{name_part}, I need to verify your PIN. "
            "Please say your four-digit PIN."
        )
    else:
        reply = "I'll need to verify who you are first. Can you look at the camera?"
    return FrontDeskResponse(
        summary=f"Auth required for {intent}",
        reply=reply,
        intent=intent,
        intent_module=intent,
        confidence=0.9,
        risk_level="high",
        pin_verified=False,
    )


def _pin_fail_reply(reason: str) -> FrontDeskResponse:
    if reason == "no_pin":
        reply = (
            "It looks like you haven't set a PIN on your account yet. "
            "Please visit your account settings and set a four-digit PIN, then come back."
        )
    elif reason == "mismatch":
        reply = "That PIN doesn't match. Please try again."
    else:
        reply = "I had trouble checking your PIN. Please try again in a moment."
    return FrontDeskResponse(
        summary=f"PIN fail: {reason}",
        reply=reply,
        intent="pin_verify",
        intent_module="pin_verify",
        confidence=0.95,
        risk_level="high",
        pin_verified=False,
    )


# ── Main turn handler ────────────────────────────────────────────────────────

def _build_context_hint(
    payload: FrontDeskRequest,
    intent: str,
    risk: str,
    effective_pin_verified: bool,
    pin_just_verified: bool,
) -> str:
    name_line = (
        f"- Customer: {payload.recognised_name} (face recognised)"
        if payload.recognised_name else "- Customer: unknown (not yet identified by face)"
    )
    lines = [
        "",
        "SESSION CONTEXT:",
        name_line,
        f"- Face match: {payload.has_face_match}",
        f"- PIN verified: {effective_pin_verified}",
        f"- Detected intent: {intent} (risk: {risk})",
    ]
    if pin_just_verified:
        if payload.pending_query:
            lines.append(
                f'- DEFERRED REQUEST: Before verifying their PIN, the customer asked: "{payload.pending_query}". '
                "Open with something like: \"You mentioned [topic] earlier — let me pull that up for you.\" "
                "Then call the right tool and give the real answer. Warm and natural, not robotic."
            )
        else:
            lines.append(
                "- PIN just verified. Warmly acknowledge and ask what they need, or answer their last question."
            )
    lines.append("")
    lines.append("Speak in 1–2 natural sentences. Use tools to look up real data — never guess.")
    return "\n".join(lines)


@traceable(name="Frontdesk Turn", run_type="chain", tags=["frontdesk", "lobby"])
def _run_frontdesk_turn(payload: FrontDeskRequest) -> FrontDeskResponse:
    timer = _Timer()
    log.info(
        "🏦 Frontdesk | robot=%s recognised=%s face=%s pin=%s",
        payload.robot_name,
        payload.recognised_name,
        payload.has_face_match,
        payload.pin_verified,
    )
    log.info("   Raw: %r", payload.utterance)

    # 1. Keyword intent classification (fast, deterministic)
    intent, risk = _classify_intent(payload.utterance)
    timer.mark("intent")
    log.info("   Intent: %s (risk=%s)", intent, risk)

    # Fast LLM for CQR, main LLM for response
    llm_small = ChatOpenAI(model="gpt-4o-mini", temperature=0.1, api_key=settings.openai_api_key)
    llm_main = ChatOpenAI(model="gpt-4o-mini", temperature=0.3, api_key=settings.openai_api_key)
    sb = get_supabase()

    # 3. PIN extraction & verification
    # Trigger whenever the frontend tells us the user is in PIN-entry mode
    # (auth_state=confirmed, pin not yet verified). No history parsing needed.
    in_pin_mode = payload.auth_state == "confirmed" and not payload.pin_verified

    # 2. CQR — skip entirely when collecting a PIN (raw digits are better)
    if in_pin_mode:
        clean_utterance = payload.utterance
    else:
        clean_utterance = _compress_utterance(payload.utterance, payload.history, llm_small)
        if clean_utterance != payload.utterance:
            log.info("   Cleaned: %r", clean_utterance)
    timer.mark("cqr")
    pin_candidate = _extract_pin(clean_utterance, llm_small) if in_pin_mode else None
    pin_just_verified = False
    effective_pin_verified = payload.pin_verified

    if pin_candidate and payload.user_id and not payload.pin_verified:
        pin_result = _verify_pin_db(sb, payload.user_id, pin_candidate)
        if pin_result == "ok":
            pin_just_verified = True
            effective_pin_verified = True
            log.info("   🔐 PIN verified")
            for msg in reversed(payload.history):
                if msg.role == "visitor":
                    pi, pr = _classify_intent(msg.text)
                    if pi != "unknown":
                        intent, risk = pi, pr
                    break
        else:
            log.info("   ❌ PIN fail: %s", pin_result)
            timer.log(log, "FRONTDESK")
            return _pin_fail_reply(pin_result)
    timer.mark("pin_check")

    # 4. Auth gate — face match requires PIN before ANY account data is shown
    if payload.has_face_match and not effective_pin_verified and risk not in ("low",):
        log.info("   🚫 Auth gate: face matched but PIN not yet verified")
        timer.log(log, "FRONTDESK")
        return _auth_challenge_reply(intent, payload)
    if risk == "high" and not effective_pin_verified:
        log.info("   🚫 Auth gate: high-risk needs PIN")
        timer.log(log, "FRONTDESK")
        return _auth_challenge_reply(intent, payload)

    # 5. Tool availability — require PIN for account data tools
    tools = []
    if payload.user_id and payload.has_face_match and effective_pin_verified:
        tools = _make_tools(payload.user_id, sb, can_execute=True)
    log.info("   Tools: %d available (execute=%s)", len(tools), effective_pin_verified)

    # 6. Build system prompt with context
    base_prompt = _ROBOT_SYSTEM.get(payload.robot_name.upper(), DEFAULT_SYSTEM)
    system_prompt = base_prompt + _build_context_hint(
        payload, intent, risk, effective_pin_verified, pin_just_verified
    )

    # 7. Build conversation history
    history_messages = []
    for msg in payload.history[-8:]:
        if msg.role == "visitor":
            history_messages.append(HumanMessage(content=msg.text))
        else:
            history_messages.append(AIMessage(content=msg.text))

    # If PIN was just verified, replace the raw PIN digits with a clear instruction.
    # Include the pending query (if any) so the LLM knows exactly what to answer.
    if pin_just_verified:
        if payload.pending_query:
            current_msg = HumanMessage(
                content=f"[PIN verified] My earlier question was: \"{payload.pending_query}\" — please answer it now."
            )
        else:
            current_msg = HumanMessage(content="[PIN verified] Please answer my earlier question now.")
    else:
        current_msg = HumanMessage(content=clean_utterance)

    # 8. Invoke — ReAct with tools, or direct LLM without
    try:
        if tools:
            agent = create_react_agent(llm_main, tools, prompt=system_prompt)
            result = agent.invoke({"messages": history_messages + [current_msg]})
            # Log tool calls for debugging
            for msg in result["messages"]:
                if hasattr(msg, "tool_calls") and msg.tool_calls:
                    for tc in msg.tool_calls:
                        log.info("   🔧 %s(%s)", tc["name"], str(tc.get("args", ""))[:80])
            reply = result["messages"][-1].content.strip()
        else:
            all_msgs = [SystemMessage(content=system_prompt)] + history_messages + [current_msg]
            result = llm_main.invoke(all_msgs)
            reply = result.content.strip()
    except Exception as e:
        log.error("LLM failure: %s", e)
        reply = "Sorry, I had trouble with that. Could you try again?"

    timer.mark("llm_done")
    timer.log(log, "FRONTDESK")

    log.info("   💬 Reply: %s", reply[:120] + ("…" if len(reply) > 120 else ""))

    return FrontDeskResponse(
        summary=f"Intent: {intent}",
        reply=reply,
        intent=intent,
        intent_module=intent,
        confidence=0.85,
        risk_level=risk,
        pin_verified=effective_pin_verified,
        clarification_count=0,
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/query", response_model=QueryResponse)
def agent_query(payload: QueryRequest, authorization: Annotated[str | None, Header()] = None) -> QueryResponse:
    """Authenticated banking agent with full tool access (used after login)."""
    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="OpenAI key not configured")

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0.2, api_key=settings.openai_api_key)
    history_messages = [
        HumanMessage(content=t.text) if t.role == "user" else AIMessage(content=t.text)
        for t in payload.history[-10:]
    ]

    user_id = None
    if authorization and authorization.lower().startswith("bearer "):
        try:
            user_id = get_current_user_id(authorization)
        except Exception:
            pass

    tools = _make_tools(user_id, get_supabase(), can_execute=True) if user_id else []
    system_prompt = _ROBOT_SYSTEM.get(payload.robot_name.upper(), DEFAULT_SYSTEM)

    if tools:
        agent = create_react_agent(llm, tools, prompt=system_prompt)
        result = agent.invoke({"messages": history_messages + [HumanMessage(content=payload.question)]})
        answer = result["messages"][-1].content
    else:
        result = llm.invoke(
            [SystemMessage(content=system_prompt)] + history_messages + [HumanMessage(content=payload.question)]
        )
        answer = result.content

    return QueryResponse(answer=answer)


@router.post("/frontdesk", response_model=FrontDeskResponse)
def frontdesk_query(payload: FrontDeskRequest) -> FrontDeskResponse:
    """Lobby front-desk turn: CQR → auth gate → ReAct agent with tools."""
    if not settings.openai_api_key:
        return FrontDeskResponse(
            summary="OpenAI key missing",
            reply="I'm having trouble connecting right now. Please try again shortly.",
            intent="general",
        )
    try:
        return _run_frontdesk_turn(payload)
    except Exception as e:
        log.exception("Frontdesk failure: %s", e)
        return FrontDeskResponse(
            summary="Pipeline error",
            reply="Sorry, something went wrong on my end. Could you try that again?",
            intent="general",
        )
