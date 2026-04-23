"""Phase 4 — LangChain banking agent.

POST /agent/query     — natural-language question → answer string
                        uses tool-calling with banking tools scoped to current_user
                        supports conversation history and contextual query rewriting
POST /agent/frontdesk — spoken lobby intent understanding + routing decisions
"""
from __future__ import annotations

import logging
import time
from typing import Annotated, Literal


# ── Pipeline latency timer ─────────────────────────────────────────────────────

class _Timer:
    """Lightweight per-request latency tracker."""
    def __init__(self) -> None:
        self._t0 = time.time()
        self._marks: dict[str, int] = {}

    def mark(self, name: str) -> None:
        self._marks[name] = round((time.time() - self._t0) * 1000)

    def log(self, logger: logging.Logger, prefix: str = "") -> None:
        parts = "  ".join(f"{k}={v}ms" for k, v in self._marks.items())
        total = round((time.time() - self._t0) * 1000)
        logger.info("⏱  %s LATENCY  %s  total=%dms", prefix, parts, total)

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


# ── Request / Response ────────────────────────────────────────────────────────

class ChatTurn(BaseModel):
    """A single turn in the desk conversation."""
    role: Literal["user", "assistant"]
    text: str


class QueryRequest(BaseModel):
    question: str
    robot_name: str = "ARIA"
    history: list[ChatTurn] = []   # prior turns for multi-turn context


class QueryResponse(BaseModel):
    answer: str
    rewritten_query: str | None = None   # the cleaned query (for debugging / UX)


class DeskMessage(BaseModel):
    role: Literal["agent", "visitor"]
    text: str


class FrontDeskRequest(BaseModel):
    utterance: str
    robot_name: str = "ARIA"
    recognised_name: str | None = None
    has_face_match: bool = False
    has_magic_link: bool = False
    history: list[DeskMessage] = []
    # Session state — frontend echoes back what the backend last returned
    clarification_count: int = 0
    auth_state: Literal["none", "face_matched", "confirmed"] = "none"
    customer_type: Literal["unknown", "existing", "new"] = "unknown"


class FrontDeskResponse(BaseModel):
    summary: str
    reply: str
    intent: Literal["open-account", "documents", "account-help", "general", "clarify"]
    should_route: bool = False
    route_target: Literal["none", "signup", "login", "magic_link"] = "none"
    confidence: float = 0.0
    # Session state deltas — frontend stores and echoes back next turn
    risk_level: Literal["low", "medium", "high"] = "low"
    escalate: bool = False          # suggest human handoff
    clarification_count: int = 0    # updated count to echo back
    intent_module: str = "general"  # which module handled this turn


# ── LangChain Tools (injected with user_id + supabase at call time) ───────────

def _make_tools(user_id: str, sb: Client):
    """Return banking tools closed over the authenticated user.

    Covers every field in the accounts and expenses tables so the agent
    can answer any question a customer might ask at a bank teller desk.
    """

    # ── Read tools ────────────────────────────────────────────────────────

    @tool
    def get_profile(_: str = "") -> str:
        """Return the customer's personal profile: full name, address,
        date of birth, when they joined, and whether Face ID is set up."""
        res = (
            sb.table("accounts")
            .select("first_name,last_name,address,date_of_birth,"
                    "face_image_path,created_at")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        face = "Yes ✓" if d.get("face_image_path") else "No — not registered"
        return (
            f"Name: {d['first_name']} {d['last_name']}\n"
            f"Address: {d.get('address') or 'Not on file'}\n"
            f"Date of birth: {d.get('date_of_birth') or 'Not on file'}\n"
            f"Member since: {d['created_at'][:10]}\n"
            f"Face ID registered: {face}"
        )

    @tool
    def get_account_summary(_: str = "") -> str:
        """Return a complete overview of the customer's account: name,
        all balances, credit score, available credit, net position, last
        login, and member-since date.  Use this for broad questions like
        'tell me everything' or 'give me a summary'."""
        res = (
            sb.table("accounts")
            .select("*")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        chq = float(d["chequing_balance"])
        sav = float(d["savings_balance"])
        cred = float(d["credit_balance"])
        lim = float(d["credit_limit"])
        avail = lim - cred
        net = chq + sav - cred
        score = d["credit_score"] or "N/A"
        util = f"{cred / lim * 100:.1f}%" if lim > 0 else "N/A"
        face = "Yes" if d.get("face_image_path") else "No"
        return (
            f"Customer: {d['first_name']} {d['last_name']}\n"
            f"Address: {d.get('address') or 'N/A'}\n"
            f"DOB: {d.get('date_of_birth') or 'N/A'}\n"
            f"Member since: {d['created_at'][:10]}\n"
            f"─── Balances ───\n"
            f"  Chequing: ${chq:,.2f}\n"
            f"  Savings: ${sav:,.2f}\n"
            f"  Credit card used: ${cred:,.2f} of ${lim:,.2f} limit\n"
            f"  Available credit: ${avail:,.2f}\n"
            f"  Net position (assets − debt): ${net:,.2f}\n"
            f"─── Credit ───\n"
            f"  Score: {score}\n"
            f"  Utilisation: {util}\n"
            f"─── Security ───\n"
            f"  Face ID: {face}\n"
            f"  Last login: {d.get('last_login_at') or 'never'}"
            f" from {d.get('last_login_loc') or 'unknown'}"
        )

    @tool
    def get_balance(account_type: str = "all") -> str:
        """Return the customer's bank balances.

        account_type can be 'chequing', 'savings', 'credit', or 'all'.
        Use this when the customer asks about a specific account balance
        or all balances together."""
        res = (
            sb.table("accounts")
            .select("first_name,chequing_balance,savings_balance,"
                    "credit_balance,credit_limit")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        chq = float(d["chequing_balance"])
        sav = float(d["savings_balance"])
        cred = float(d["credit_balance"])
        lim = float(d["credit_limit"])
        avail = lim - cred

        t = account_type.lower().strip()
        if "chequ" in t or "check" in t or "current" in t:
            return f"{d['first_name']}'s chequing account: ${chq:,.2f}"
        if "sav" in t:
            return f"{d['first_name']}'s savings account: ${sav:,.2f}"
        if "cred" in t:
            return (
                f"{d['first_name']}'s credit card:\n"
                f"  Balance owing: ${cred:,.2f}\n"
                f"  Credit limit: ${lim:,.2f}\n"
                f"  Available credit: ${avail:,.2f}"
            )
        # 'all' or unrecognised → return everything
        return (
            f"{d['first_name']}'s balances:\n"
            f"  Chequing: ${chq:,.2f}\n"
            f"  Savings: ${sav:,.2f}\n"
            f"  Credit card balance: ${cred:,.2f} / ${lim:,.2f} limit\n"
            f"  Available credit: ${avail:,.2f}\n"
            f"  Total deposits: ${chq + sav:,.2f}"
        )

    @tool
    def get_credit_info(_: str = "") -> str:
        """Return full credit details: credit score with rating category,
        credit utilisation ratio, balance, limit, available credit, and
        minimum payment estimate."""
        res = (
            sb.table("accounts")
            .select("first_name,credit_score,credit_balance,credit_limit")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        score = d["credit_score"]
        used = float(d["credit_balance"] or 0)
        limit = float(d["credit_limit"] or 0)
        avail = limit - used
        util = f"{used / limit * 100:.1f}%" if limit > 0 else "N/A"

        if score is None:
            rating = "Not available"
        elif score >= 760:
            rating = f"{score} — Excellent"
        elif score >= 725:
            rating = f"{score} — Very Good"
        elif score >= 660:
            rating = f"{score} — Good"
        elif score >= 560:
            rating = f"{score} — Fair"
        else:
            rating = f"{score} — Needs Improvement"

        min_payment = max(10.0, used * 0.02)  # typical 2% or $10

        return (
            f"Credit report for {d['first_name']}:\n"
            f"  Credit score: {rating}\n"
            f"  Balance owing: ${used:,.2f}\n"
            f"  Credit limit: ${limit:,.2f}\n"
            f"  Available credit: ${avail:,.2f}\n"
            f"  Utilisation: {util}\n"
            f"  Estimated minimum payment: ${min_payment:,.2f}"
        )

    @tool
    def get_expenses(months: str = "3") -> str:
        """Return the customer's expenses grouped by category for the
        given number of months. Use for questions like 'what did I spend'
        or 'show me my spending breakdown'."""
        from datetime import date, timedelta
        try:
            m = max(1, min(int(months), 24))
        except ValueError:
            m = 3
        since = (date.today() - timedelta(days=31 * m)).isoformat()
        res = (
            sb.table("expenses")
            .select("category,amount,occurred_at")
            .eq("user_id", user_id)
            .gte("occurred_at", since)
            .order("occurred_at", desc=True)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return f"No expenses found in the last {m} month(s)."
        totals: dict[str, float] = {}
        count: dict[str, int] = {}
        for r in rows:
            cat = r["category"]
            totals[cat] = totals.get(cat, 0) + float(r["amount"])
            count[cat] = count.get(cat, 0) + 1
        lines = "\n".join(
            f"  {cat}: ${amt:,.2f} ({count[cat]} transaction{'s' if count[cat] > 1 else ''})"
            for cat, amt in sorted(totals.items(), key=lambda x: -x[1])
        )
        total = sum(totals.values())
        return (
            f"Spending breakdown — last {m} month(s):\n"
            f"{lines}\n"
            f"  ─────────────\n"
            f"  TOTAL: ${total:,.2f} across {len(rows)} transactions"
        )

    @tool
    def get_spending_for_category(category: str) -> str:
        """Return spending for a specific category (e.g. food, rent,
        transport, subscriptions). Use when the customer asks 'how much
        did I spend on food' or 'what are my rent payments'."""
        from datetime import date, timedelta
        since = (date.today() - timedelta(days=93)).isoformat()  # ~3 months
        res = (
            sb.table("expenses")
            .select("amount,occurred_at")
            .eq("user_id", user_id)
            .eq("category", category.lower().strip())
            .gte("occurred_at", since)
            .order("occurred_at", desc=True)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return f"No '{category}' expenses found in the last 3 months."
        total = sum(float(r["amount"]) for r in rows)
        lines = "\n".join(
            f"  {r['occurred_at']}: ${float(r['amount']):,.2f}" for r in rows
        )
        return (
            f"'{category.capitalize()}' spending (last 3 months):\n"
            f"{lines}\n"
            f"  Total: ${total:,.2f} across {len(rows)} transactions"
        )

    @tool
    def get_recent_transactions(limit: str = "10") -> str:
        """Return the customer's most recent individual transactions
        (expenses) as a list with dates, categories, and amounts."""
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
            return "No transactions found."
        lines = "\n".join(
            f"  {r['occurred_at']} | {r['category']:15s} | ${float(r['amount']):,.2f}"
            for r in rows
        )
        return f"Last {len(rows)} transactions:\n{lines}"

    @tool
    def get_net_worth(_: str = "") -> str:
        """Calculate and return the customer's net financial position:
        total assets (chequing + savings) minus liabilities (credit card
        balance)."""
        res = (
            sb.table("accounts")
            .select("first_name,chequing_balance,savings_balance,"
                    "credit_balance")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        chq = float(d["chequing_balance"])
        sav = float(d["savings_balance"])
        cred = float(d["credit_balance"])
        assets = chq + sav
        net = assets - cred
        return (
            f"{d['first_name']}'s financial snapshot:\n"
            f"  Total deposits: ${assets:,.2f}\n"
            f"    Chequing: ${chq:,.2f}\n"
            f"    Savings: ${sav:,.2f}\n"
            f"  Credit card debt: ${cred:,.2f}\n"
            f"  ─────────────\n"
            f"  Net position: ${net:,.2f}"
        )

    @tool
    def get_last_login(_: str = "") -> str:
        """Return when and where the customer last logged in, plus
        whether Face ID is set up (security status)."""
        res = (
            sb.table("accounts")
            .select("last_login_at,last_login_loc,face_image_path")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        at = d.get("last_login_at") or "never"
        loc = d.get("last_login_loc") or "unknown location"
        face = "Registered ✓" if d.get("face_image_path") else "Not set up"
        return (
            f"Last login: {at} from {loc}\n"
            f"Face ID status: {face}"
        )

    # ── Action tools ──────────────────────────────────────────────────────

    @tool
    def transfer_between_accounts(direction: str, amount: str) -> str:
        """Transfer money between chequing and savings accounts.

        direction must be 'chequing_to_savings' or 'savings_to_chequing'.
        amount is the dollar amount to transfer (e.g. '500')."""
        try:
            amt = round(float(amount), 2)
            if amt <= 0:
                return "Transfer amount must be positive."
        except ValueError:
            return f"Invalid amount: {amount}"

        res = (
            sb.table("accounts")
            .select("chequing_balance,savings_balance")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."

        chq = float(res.data["chequing_balance"])
        sav = float(res.data["savings_balance"])

        d = direction.lower().strip()
        if d == "chequing_to_savings":
            if amt > chq:
                return f"Insufficient funds. Chequing balance is ${chq:,.2f}."
            new_chq = chq - amt
            new_sav = sav + amt
            label = "chequing → savings"
        elif d == "savings_to_chequing":
            if amt > sav:
                return f"Insufficient funds. Savings balance is ${sav:,.2f}."
            new_chq = chq + amt
            new_sav = sav - amt
            label = "savings → chequing"
        else:
            return ("Invalid direction. Use 'chequing_to_savings' or "
                    "'savings_to_chequing'.")

        sb.table("accounts").update({
            "chequing_balance": new_chq,
            "savings_balance": new_sav,
        }).eq("user_id", user_id).execute()

        return (
            f"Transfer complete: ${amt:,.2f} moved {label}.\n"
            f"New chequing balance: ${new_chq:,.2f}\n"
            f"New savings balance: ${new_sav:,.2f}"
        )

    @tool
    def pay_credit_card(amount: str) -> str:
        """Pay towards the credit card balance from the chequing account.

        amount is the dollar amount to pay (e.g. '200'), or 'full' to
        pay the entire outstanding balance."""
        res = (
            sb.table("accounts")
            .select("chequing_balance,credit_balance")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."

        chq = float(res.data["chequing_balance"])
        cred = float(res.data["credit_balance"])

        if amount.lower().strip() == "full":
            amt = cred
        else:
            try:
                amt = round(float(amount), 2)
                if amt <= 0:
                    return "Payment amount must be positive."
            except ValueError:
                return f"Invalid amount: {amount}"

        if cred <= 0:
            return "No credit card balance to pay — you're all clear!"
        if amt > cred:
            amt = cred  # cap at outstanding balance
        if amt > chq:
            return (
                f"Insufficient funds in chequing (${chq:,.2f}) to pay "
                f"${amt:,.2f}. Try a smaller amount."
            )

        new_chq = chq - amt
        new_cred = cred - amt

        sb.table("accounts").update({
            "chequing_balance": new_chq,
            "credit_balance": new_cred,
        }).eq("user_id", user_id).execute()

        return (
            f"Credit card payment of ${amt:,.2f} processed.\n"
            f"New chequing balance: ${new_chq:,.2f}\n"
            f"New credit card balance: ${new_cred:,.2f}"
        )

    return [
        # Read tools
        get_profile,
        get_account_summary,
        get_balance,
        get_credit_info,
        get_expenses,
        get_spending_for_category,
        get_recent_transactions,
        get_net_worth,
        get_last_login,
        # Action tools
        transfer_between_accounts,
        pay_credit_card,
    ]


# ── Agent personalities ───────────────────────────────────────────────────────

_TOOL_GUIDANCE = (
    " Always use the right tool — never invent numbers. "
    "get_balance for balances · get_credit_info for credit · get_expenses or "
    "get_spending_for_category for spending · get_profile for personal info · "
    "get_account_summary for a full overview · transfer_between_accounts for "
    "transfers · pay_credit_card for card payments."
)

_VOICE_RULES = """

UNIVERSAL BANKING CONVERSATION FLOW — follow this every turn:
  1. INTENT  – identify what the customer actually needs in one phrase.
  2. VERIFY  – if money movement, account changes, or sensitive data: confirm identity first.
  3. EXECUTE – call the right tool. Never guess or fabricate data.
  4. CONFIRM – repeat the outcome in one short sentence. ("Done. Transfer complete.")
  5. CLOSE   – offer exactly ONE relevant next step, not a menu.

VOICE FORMAT RULES (mandatory):
  • One thought per response. 1–2 spoken sentences maximum.
  • Natural English only. Speak numbers: "twelve hundred" not "$1,200.00".
  • Never read raw tables, bullet lists, or separator lines from tool output.
  • Before any transaction (transfer, payment): confirm explicitly.
    Example: "You want to move three hundred dollars from chequing to savings — should I do that?"
  • After completing an action: short confirmation only. "Done. Transfer complete."
  • Offer ONE next step. Not five. ("Want to see the last three transactions?")
  • Repair question if unsure twice: "Did you mean your debit card or credit card?"
  • If a request needs escalation: "This one needs a specialist — want me to arrange that?"
  • Never mention tools, APIs, or internal system names.
  • Resolve pronouns from context: 'it', 'that account', 'the other one'.
"""

_ROBOT_SYSTEM: dict[str, str] = {
    "ARIA": (
        "You are ARIA, a professional and warm bank teller at BankBot Vision. "
        "You speak naturally and briefly, like a trusted teller face-to-face."
        + _TOOL_GUIDANCE + _VOICE_RULES
    ),
    "MAX": (
        "You are MAX, a fast and precise bank teller at BankBot Vision. "
        "Direct answers, short sentences, confident tone. No filler."
        + _TOOL_GUIDANCE + _VOICE_RULES
    ),
    "ZED": (
        "You are ZED, a calm and analytical banking advisor at BankBot Vision. "
        "Measured confidence. One brief insight when it genuinely helps."
        + _TOOL_GUIDANCE + _VOICE_RULES
    ),
}

DEFAULT_SYSTEM = _ROBOT_SYSTEM["ARIA"]


# ── Contextual Query Rewriting (CQR) ─────────────────────────────────────────

_CQR_PROMPT = (
    "You are a query understanding module for a banking voice assistant. "
    "The customer's speech may be unclear, rambling, or contain filler words. "
    "Your job is to compress their utterance into ONE clean, precise query "
    "that a banking agent can act on.\n\n"
    "Rules:\n"
    "1. Remove filler words (um, uh, like, you know, so).\n"
    "2. Resolve pronouns using conversation history ('it' → 'my savings balance').\n"
    "3. If the customer asks multiple things, combine into one compound query.\n"
    "4. Preserve the customer's actual intent — do NOT add things they didn't ask.\n"
    "5. Keep the rewrite SHORT — one sentence, max two.\n"
    "6. If the speech is already clean and clear, return it mostly unchanged.\n"
)

_LOBBY_CQR_PROMPT = (
    "You are a speech compression module at a virtual bank lobby kiosk. "
    "A visitor has just spoken to a robot greeter. Their speech was captured by a "
    "microphone and may be noisy, accented, fragmented, or full of filler words.\n\n"
    "Your job: compress what they said into ONE clean, precise sentence that "
    "captures their true intent.\n\n"
    "Rules:\n"
    "1. Remove all filler words (um, uh, like, so, you know, basically, kind of).\n"
    "2. Fix Whisper transcription errors — e.g. 'checking' often means 'chequing', "
    "'I want to' fragments mean the visitor wants that service.\n"
    "3. If they said their name, keep it exactly.\n"
    "4. Infer the banking intent: check balance / open account / loan / credit card / "
    "mortgage / documents / speak to advisor / general question.\n"
    "5. Output ONE sentence only. No preamble, no explanation.\n"
    "6. If the speech is already clear and short, return it unchanged.\n"
    "\nExamples:\n"
    "  Raw: 'uh yeah so I was like wondering if I could maybe um check my you know balance'\n"
    "  Clean: 'I want to check my account balance.'\n\n"
    "  Raw: 'so I need to open a new account like a savings one'\n"
    "  Clean: 'I want to open a new savings account.'\n\n"
    "  Raw: 'hi my name is Nirav and I just want to know about mortgage rates'\n"
    "  Clean: 'My name is Nirav and I want to know about mortgage rates.'\n"
)


@traceable(name="Query Compression (CQR)", run_type="llm", tags=["cqr", "banking"])
def _rewrite_query(
    raw_question: str,
    history: list[ChatTurn],
    llm: ChatOpenAI,
) -> str:
    """Compress messy speech into a clean query using conversation context.

    Returns the original question unchanged if rewriting fails or the
    input is already short and clean.
    """
    # Skip CQR for very short / already-clean inputs
    words = raw_question.split()
    if len(words) <= 8 and not history:
        log.info("\n🔄 CQR: Skipped (short/clean input)")
        return raw_question

    log.info("\n🔄 CQR: Rewriting messy input...")
    log.info("   Raw: %r", raw_question)

    history_text = "\n".join(
        f"{'CUSTOMER' if t.role == 'user' else 'AGENT'}: {t.text}"
        for t in history[-6:]
    ) or "No prior conversation."

    try:
        result = llm.invoke([
            SystemMessage(content=_CQR_PROMPT),
            HumanMessage(
                content=(
                    f"Conversation so far:\n{history_text}\n\n"
                    f"Latest customer utterance:\n\"{raw_question}\"\n\n"
                    f"Rewritten query:"
                )
            ),
        ])
        rewritten = result.content.strip().strip('"').strip()
        if rewritten and len(rewritten) < len(raw_question) * 3:
            log.info("   Clean: %r", rewritten)
            return rewritten
    except Exception as e:
        log.warning("   CQR failed: %s", e)

    return raw_question


@traceable(name="Lobby Speech Compression", run_type="llm", tags=["cqr", "lobby"])
def _compress_utterance(
    raw_utterance: str,
    history: list[ChatTurn],
    llm: ChatOpenAI,
) -> str:
    """Lobby-tuned compression: clean up noisy voice input before frontdesk LLM.

    Handles accents, Whisper artifacts, filler words, and fragmented sentences.
    Returns original if already clean or compression fails.
    """
    words = raw_utterance.split()
    # Skip compression for short utterances — most lobby speech is under 15 words
    if len(words) <= 14:
        return raw_utterance

    log.info("\n🎙️  Lobby CQR: Compressing utterance...")
    log.info("   Raw: %r", raw_utterance)

    history_text = "\n".join(
        f"{'VISITOR' if t.role == 'user' else 'ROBOT'}: {t.text}"
        for t in history[-4:]
    ) or "First visitor utterance."

    try:
        result = llm.invoke(
            [
                SystemMessage(content=_LOBBY_CQR_PROMPT),
                HumanMessage(
                    content=(
                        f"Recent conversation:\n{history_text}\n\n"
                        f"Latest visitor speech:\n\"{raw_utterance}\"\n\n"
                        f"Compressed:"
                    )
                ),
            ],
            config={"run_name": f"Compress: {raw_utterance[:50]}"},
        )
        compressed = result.content.strip().strip('"').strip()
        if compressed and len(compressed) < len(raw_utterance) * 2:
            log.info("   Compressed: %r", compressed)
            return compressed
    except Exception as e:
        log.warning("   Lobby CQR failed: %s", e)

    return raw_utterance


# ── Intent classification — fast keyword triage, no extra LLM call ────────────

_INTENT_MAP: list[tuple[str, str, tuple[str, ...]]] = [
    # (module, risk_level, keywords)
    ("fraud_dispute",   "high",   ("suspicious", "fraud", "don't recognize", "dispute",
                                   "unauthorized", "didn't make", "not mine", "scam")),
    ("card_services",   "high",   ("lost card", "stolen card", "block card", "freeze card",
                                   "unfreeze", "replacement card", "cancel card", "pin",
                                   "spend limit", "travel notice")),
    ("account_action",  "high",   ("transfer", "move money", "send money", "pay my",
                                   "bill payment", "move from", "move to", "pay rogers",
                                   "pay hydro", "pay bell", "chequing to savings",
                                   "savings to chequing")),
    ("account_read",    "medium", ("my balance", "check balance", "how much", "statement",
                                   "transactions", "recent", "last few", "spending",
                                   "expenses", "what did i spend", "credit score",
                                   "available credit", "account summary", "my savings",
                                   "my chequing", "overview")),
    ("login_help",      "medium", ("can't log in", "locked", "forgot password",
                                   "reset password", "otp", "verification code",
                                   "access issue", "login help", "sign in problem")),
    ("new_account",     "low",    ("open account", "new account", "join", "first time",
                                   "become a customer", "sign up", "register", "apply",
                                   "create account", "start an account")),
    ("product_info",    "low",    ("which account", "best account", "compare", "recommend",
                                   "cashback", "travel card", "low fee", "student account",
                                   "business account", "interest rate", "mortgage rate")),
    ("branch_appt",     "low",    ("branch", "location", "nearest", "in person",
                                   "appointment", "talk to someone", "speak to a person",
                                   "human", "advisor", "specialist", "callback")),
]


def _classify_intent(utterance: str) -> tuple[str, str]:
    """Keyword triage → (intent_module, risk_level). O(n) with no LLM call."""
    lower = utterance.lower()
    for module, risk, keywords in _INTENT_MAP:
        if any(k in lower for k in keywords):
            return module, risk
    return "general", "low"


def _auth_gate(
    risk_level: str,
    payload: FrontDeskRequest,
) -> FrontDeskResponse | None:
    """Return a deflect response when the visitor's auth level is insufficient.

    Returns None when the request can proceed normally.
    """
    if risk_level == "low":
        return None  # public info — no auth needed

    if risk_level == "medium" and payload.has_face_match:
        return None  # face match is sufficient for read-only account data

    if risk_level == "high" and payload.has_face_match and payload.has_magic_link:
        return None  # full session available — proceed

    # Not enough auth — deflect cleanly and calmly
    name_part = f", {payload.recognised_name}" if payload.recognised_name else ""
    if payload.has_face_match:
        reply = (
            f"I can help with that{name_part} — I just need to open a secure session first. "
            "Shall I do that?"
        )
    else:
        reply = "I can help with that. Could you confirm your name so I can verify you?"

    return FrontDeskResponse(
        summary="Auth insufficient for this request.",
        reply=reply,
        intent="account-help",
        should_route=False,
        route_target="none",
        confidence=0.88,
        risk_level=risk_level,
        clarification_count=payload.clarification_count,
        intent_module="auth_gate",
    )


# ── Module-specific prompt snippets injected into the system prompt ───────────

_MODULE_PROMPTS: dict[str, str] = {
    "account_read": (
        "MODULE: Account Read. The visitor wants to see their account data. "
        "Auth is already confirmed for this request. Retrieve and speak data naturally. "
        "Say balances in plain English. Offer ONE follow-up only."
    ),
    "account_action": (
        "MODULE: Account Action. MONEY MOVEMENT — highest risk. "
        "Follow this exactly: (1) state what you understood, "
        "(2) ask 'Should I proceed?' — wait for yes, "
        "(3) execute, (4) confirm in one sentence. Never skip the confirmation step."
    ),
    "card_services": (
        "MODULE: Card Services. Lead with empathy. "
        "Offer the most urgent action first (block card). "
        "Confirm before any irreversible step. "
        "Ask: 'Do you want me to block it now and start a replacement?'"
    ),
    "fraud_dispute": (
        "MODULE: Fraud Dispute. Stay calm and move quickly. "
        "Ask for merchant name or amount to find the transaction. "
        "Offer to flag it and protect the card immediately. "
        "Escalate to specialist if visitor is distressed."
    ),
    "new_account": (
        "MODULE: New Account. Guide with curiosity, not a menu. "
        "Ask: 'Are you looking for everyday banking, savings, student, or business?' "
        "Recommend the best fit in one sentence. Explain why in one phrase."
    ),
    "product_info": (
        "MODULE: Product Info. Answer from general banking knowledge. "
        "Focus on what the visitor actually needs — low fees, rewards, or savings rate. "
        "Recommend one product with one clear reason."
    ),
    "login_help": (
        "MODULE: Login Help. Ask which issue: locked account, forgotten password, or OTP. "
        "Guide through the right resolution. "
        "If repeated failure: 'This might need a specialist — want me to arrange that?'"
    ),
    "branch_appt": (
        "MODULE: Branch / Appointment. Offer: find nearest branch OR book a specialist callback. "
        "Ask which they prefer. Keep it simple — one sentence."
    ),
    "general": (
        "MODULE: General. Respond naturally. "
        "If intent is unclear, ask ONE focused clarifying question."
    ),
}


def _contains_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


def _fallback_frontdesk_response(payload: FrontDeskRequest) -> FrontDeskResponse:
    lower = payload.utterance.lower().strip()
    prior_agent = next((m.text.lower() for m in reversed(payload.history) if m.role == "agent"), "")

    summary = payload.utterance.strip() or "The visitor needs help at the front desk."

    if not lower:
        return FrontDeskResponse(
            summary="The visitor has not said anything yet.",
            reply="I'm right here — what can I help you with today?",
            intent="clarify",
            confidence=0.1,
        )

    is_confirmation = (
        lower in {
            "yes",
            "yeah",
            "yep",
            "sure",
            "okay",
            "ok",
            "go ahead",
            "please do",
            "let's do it",
            "continue",
        }
        or lower.startswith("yes")
        or lower.startswith("yeah")
        or lower.startswith("sure")
        or lower.startswith("ok")
        or lower.startswith("okay")
    )

    wants_open_account = _contains_any(
        lower,
        (
            "open account",
            "create account",
            "new account",
            "first visit",
            "first time",
            "join the bank",
            "become a customer",
        ),
    )
    wants_documents = _contains_any(
        lower,
        ("passport", "document", "documents", "identification", "paperwork", "form", "id "),
    )
    wants_sensitive_account_help = _contains_any(
        lower,
        (
            "balance",
            "money",
            "credit score",
            "credit card",
            "invest",
            "investment",
            "loan",
            "mortgage",
            "account details",
            "transactions",
            "savings",
            "checking",
            "chequing",
            "card",
        ),
    )

    if wants_open_account:
        if _contains_any(lower, ("go ahead", "start now", "open it now", "let's do it", "proceed")):
            return FrontDeskResponse(
                summary="The visitor wants to open a new bank account now.",
                reply="Perfect, I'll get that started for you right now.",
                intent="open-account",
                should_route=True,
                route_target="signup",
                confidence=0.93,
            )
        return FrontDeskResponse(
            summary="The visitor wants to open a new bank account.",
            reply="Of course! I just need a moment to set that up — shall I start the account opening now?",
            intent="open-account",
            confidence=0.82,
        )

    if wants_sensitive_account_help:
        if payload.has_face_match and payload.has_magic_link and (
            is_confirmation or "open your secure banking" in prior_agent or "take you inside" in prior_agent
        ):
            return FrontDeskResponse(
                summary="The visitor wants secure help with their existing account and agreed to continue inside.",
                reply=(
                    f"I have what I need{f', {payload.recognised_name}' if payload.recognised_name else ''}. "
                    "I am opening your secure banking session now."
                ),
                intent="account-help",
                should_route=True,
                route_target="magic_link",
                confidence=0.95,
            )
        if payload.has_face_match and payload.has_magic_link:
            return FrontDeskResponse(
                summary="The visitor wants account-specific help that requires secure access.",
                reply=(
                    f"Happy to help{f', {payload.recognised_name}' if payload.recognised_name else ''}. "
                    "Want me to open a secure session so I can pull that up?"
                ),
                intent="account-help",
                confidence=0.86,
            )
        if is_confirmation and ("secure sign-in" in prior_agent or "sign you in" in prior_agent):
            return FrontDeskResponse(
                summary="The visitor agreed to continue through secure sign-in.",
                reply="Great, taking you there now.",
                intent="account-help",
                should_route=True,
                route_target="login",
                confidence=0.9,
            )
        return FrontDeskResponse(
            summary="The visitor wants account-specific help but is not securely inside yet.",
            reply="I'd need to verify you first for that. Want me to take you to the sign-in page?",
            intent="account-help",
            confidence=0.84,
        )

    if wants_documents:
        if payload.has_face_match and payload.has_magic_link and (
            is_confirmation or "continue with your documents" in prior_agent
        ):
            return FrontDeskResponse(
                summary="The visitor agreed to continue document handling inside secure banking.",
                reply="I am opening your secure session now so we can continue with your documents safely.",
                intent="documents",
                should_route=True,
                route_target="magic_link",
                confidence=0.92,
            )
        if is_confirmation and ("secure sign-in" in prior_agent or "documents safely" in prior_agent):
            return FrontDeskResponse(
                summary="The visitor agreed to continue document handling through sign-in.",
                reply="I am taking you to secure sign-in now so we can continue.",
                intent="documents",
                should_route=True,
                route_target="login",
                confidence=0.88,
            )
        return FrontDeskResponse(
            summary="The visitor needs help with identification or documents.",
            reply="I can help with documents and identification. Do you want me to continue in a secure session now?",
            intent="documents",
            confidence=0.8,
        )

    if is_confirmation:
        if "onboarding flow" in prior_agent or "open an account" in prior_agent:
            return FrontDeskResponse(
                summary="The visitor confirmed they want to start opening an account.",
                reply="I am starting the account opening flow now.",
                intent="open-account",
                should_route=True,
                route_target="signup",
                confidence=0.9,
            )
        if "secure banking session" in prior_agent or "secure sign-in" in prior_agent:
            return FrontDeskResponse(
                summary="The visitor confirmed they want to continue inside secure banking.",
                reply=(
                    "I am opening your secure session now."
                    if payload.has_magic_link
                    else "I am taking you to secure sign-in now."
                ),
                intent="account-help",
                should_route=True,
                route_target="magic_link" if payload.has_magic_link else "login",
                confidence=0.88,
            )

    return FrontDeskResponse(
        summary=summary,
        reply="I'm here to help — what's the main thing you need today?",
        intent="clarify",
        confidence=0.45,
    )


def _frontdesk_system_prompt(robot_name: str) -> str:
    return f"""You are {robot_name}, a professional bank teller at BankBot Vision's lobby.
You are speaking face-to-face with a visitor. Every response is spoken aloud.

UNIVERSAL FLOW — follow for every turn:
  1. WELCOME   – "Hi, what can I help you with today?" (first turn only)
  2. INTENT    – understand what they actually need. Ask ONE clarifying question if unclear.
  3. RISK CHECK– balance / transactions / card / account changes require secure sign-in.
               Tell them calmly: "I can help — I just need to verify you first."
  4. SOLVE     – answer general questions directly. Guide new customers. Explain products.
  5. CONFIRM   – repeat the next step or outcome in one sentence.
  6. CLOSE     – offer ONE relevant next action. Nothing more.

SCRIPT PATTERNS (use these as natural language templates):
  Balance:      "I can pull that up, but I'll need to verify your identity first."
  Transactions: "Happy to show those — I just need you to sign in securely."
  Transfer:     "I can do that transfer after a quick identity check."
  New account:  "Welcome! Are you looking for everyday banking, savings, student, or business?"
  Lost card:    "I'm sorry about that. I can block it now and arrange a replacement. Shall I start?"
  Suspicious:   "I can flag that and start a dispute — tell me the merchant name or amount."
  Product Q:    "What matters most — low fees, cashback, or savings growth?"
  Escalation:   "This one needs a specialist. I can connect you so you won't need to repeat yourself."

REPLY RULES:
  • 1–2 spoken sentences only. Natural English. Warm, professional.
  • One question per turn. Never list more than two options.
  • No menus, no bullet lists, no 'I can help with A, B, C, or D'.
  • Never mention routing labels, internal tools, or system logic.
  • If confidence is low after two attempts, offer specialist handoff.

ROUTING (routing is restricted — most flows stay in lobby):
  • should_route=true ONLY when visitor has confirmed AND magic_link is available.
  • All other should_route decisions: false. Keep talking.
  • route_target: none | magic_link
  • intent: open-account | account-help | documents | general | clarify
  • confidence: 0.0–1.0"""


def _normalize_frontdesk_decision(
    decision: FrontDeskResponse,
    payload: FrontDeskRequest,
) -> FrontDeskResponse:
    reply_lower = decision.reply.lower()

    if any(
        phrase in reply_lower
        for phrase in (
            "would you like",
            "do you want",
            "shall i",
            "are you ready",
            "can i take you",
            "should i open",
        )
    ):
        decision.should_route = False
        if decision.route_target != "none":
            decision.route_target = "none"

    if decision.route_target == "magic_link" and not payload.has_magic_link:
        decision.route_target = "login"
    if decision.should_route and decision.route_target == "none":
        decision.should_route = False

    return decision


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/query", response_model=QueryResponse)
def agent_query(
    payload: QueryRequest,
    authorization: Annotated[str | None, Header()] = None,
) -> QueryResponse:
    """Run the banking agent and return a natural-language answer.

    Features:
    - Contextual Query Rewriting (CQR): messy speech → clean query
    - Multi-turn memory: conversation history informs follow-ups
    - Authenticated: full banking tools scoped to the user
    - Unauthenticated: general banking assistant (no tools)
    """
    timer = _Timer()
    log.info("\n" + "═" * 60)
    log.info("🤖 AGENT QUERY  robot=%s  history=%d", payload.robot_name, len(payload.history))
    log.info("   User: %r", payload.question)
    log.info("═" * 60)

    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="OpenAI key not configured")

    system_prompt = _ROBOT_SYSTEM.get(payload.robot_name.upper(), DEFAULT_SYSTEM)

    llm = ChatOpenAI(
        model="gpt-4o-mini",
        temperature=0.2,
        api_key=settings.openai_api_key,
    )

    # ── Step 1: Contextual Query Rewriting ────────────────────────────────
    clean_query = _rewrite_query(payload.question, payload.history, llm)
    timer.mark("cqr")

    # ── Step 2: Build conversation history as LangChain messages ─────────
    history_messages: list[HumanMessage | AIMessage] = []
    for turn in payload.history[-10:]:  # cap at last 10 turns
        if turn.role == "user":
            history_messages.append(HumanMessage(content=turn.text))
        else:
            history_messages.append(AIMessage(content=turn.text))
    log.info("📜 History: %d turns loaded", len(history_messages))

    # ── Step 3: Try to authenticate ──────────────────────────────────────
    tools: list = []
    if authorization and authorization.lower().startswith("bearer "):
        try:
            user_id = get_current_user_id(authorization)
            sb = get_supabase()
            tools = _make_tools(user_id, sb)
            log.info("🔐 Auth: user=%s  tools=%d", user_id[:8] + "…", len(tools))
        except HTTPException:
            log.info("🔓 Auth: token invalid — running without tools")
    else:
        log.info("🔓 Auth: no token — running without tools")

    # ── Step 4: Run agent or direct LLM (wrapped for LangSmith) ─────────────
    @traceable(
        name=f"[{payload.robot_name}] {payload.question[:60]}",
        run_type="chain",
        tags=["banking", "agent", "authenticated" if tools else "guest"],
        metadata={
            "robot": payload.robot_name,
            "question": payload.question,
            "rewritten_query": clean_query,
            "authenticated": bool(tools),
            "tool_count": len(tools),
        },
    )
    def _run_agent() -> str:
        if tools:
            tool_names = [t.name for t in tools]
            log.info("🛠️  Tools available: %s", ", ".join(tool_names))
            agent = create_react_agent(llm, tools, prompt=system_prompt)
            all_messages = history_messages + [HumanMessage(content=clean_query)]
            result = agent.invoke({"messages": all_messages})
            tool_calls = [
                msg for msg in result["messages"]
                if hasattr(msg, "tool_calls") and msg.tool_calls
            ]
            if tool_calls:
                for tc_msg in tool_calls:
                    for tc in tc_msg.tool_calls:
                        log.info("   🔧 Tool called: %s(%s)", tc["name"], str(tc.get("args", ""))[:80])
            return result["messages"][-1].content
        else:
            log.info("💬 Mode: Direct LLM (no tools)")
            general_prompt = (
                system_prompt
                + " The visitor has not signed in yet, so you cannot access any "
                "account data. Help with general banking questions, guide them to "
                "sign in or open an account, and answer questions about BankBot "
                "Vision services. Keep answers concise."
            )
            all_messages = (
                [SystemMessage(content=general_prompt)]
                + history_messages
                + [HumanMessage(content=clean_query)]
            )
            result = llm.invoke(all_messages)
            return result.content

    answer = _run_agent()
    timer.mark("llm_done")
    timer.log(log, "AGENT_QUERY")
    log.info("✅ ANSWER: %s", answer[:120] + ("…" if len(answer) > 120 else ""))
    log.info("─" * 60)

    return QueryResponse(
        answer=answer,
        rewritten_query=clean_query if clean_query != payload.question else None,
    )


@traceable(
    name="Frontdesk Conversation Turn",
    run_type="chain",
    tags=["frontdesk", "lobby"],
)
def _frontdesk_llm_call(payload: FrontDeskRequest) -> FrontDeskResponse:
    """Intent triage → auth gate → optional CQR → module LLM → normalize."""
    timer = _Timer()

    llm = ChatOpenAI(
        model="gpt-4o-mini",
        temperature=0.15,
        api_key=settings.openai_api_key,
    )

    # ── Step 1: Fast keyword intent + risk classification (no LLM) ───────────
    intent_module, risk_level = _classify_intent(payload.utterance)
    timer.mark("intent")
    log.info("   🎯 Module: %s  Risk: %s", intent_module, risk_level)

    # ── Step 2: Auth gate — deflect without LLM if auth is insufficient ──────
    gate = _auth_gate(risk_level, payload)
    if gate:
        timer.mark("auth_gate")
        timer.log(log, "FRONTDESK")
        return gate

    # ── Step 3: Clarification limit — offer specialist after 2 retries ───────
    if payload.clarification_count >= 2 and intent_module == "general":
        timer.log(log, "FRONTDESK")
        return FrontDeskResponse(
            summary="Repeated clarification failure — escalate.",
            reply="I want to make sure I get this right for you. Would you like to speak with a specialist who can help directly?",
            intent="clarify",
            confidence=0.4,
            escalate=True,
            risk_level=risk_level,
            intent_module="escalation",
            clarification_count=payload.clarification_count,
        )

    # ── Step 4: Optional CQR — skip for short utterances ────────────────────
    clean_utterance = _compress_utterance(payload.utterance, payload.history, llm)
    timer.mark("cqr")
    if clean_utterance != payload.utterance:
        log.info("   🗜️  Compressed: %r → %r", payload.utterance[:60], clean_utterance[:60])

    # ── Step 5: LLM structured output with module-specific prompt ────────────
    module_guidance = _MODULE_PROMPTS.get(intent_module, _MODULE_PROMPTS["general"])
    system_content = _frontdesk_system_prompt(payload.robot_name) + f"\n\n{module_guidance}"
    structured_llm = llm.with_structured_output(FrontDeskResponse)

    history_lines = "\n".join(
        f"{msg.role.upper()}: {msg.text}" for msg in payload.history[-6:]
    ) or "First turn."

    name_ctx = f"Recognised: {payload.recognised_name}." if payload.recognised_name else "Visitor unrecognised."
    session_ctx = (
        f"{name_ctx} Face match: {payload.has_face_match}. "
        f"Magic link: {payload.has_magic_link}. Auth: {payload.auth_state}. "
        f"Customer type: {payload.customer_type}. Risk: {risk_level}."
    )

    timer.mark("llm_start")
    decision = structured_llm.invoke(
        [
            SystemMessage(content=system_content),
            HumanMessage(
                content=(
                    f"Session:\n{session_ctx}\n\n"
                    f"Recent turns:\n{history_lines}\n\n"
                    f"Visitor:\n{clean_utterance}"
                )
            ),
        ],
        config={
            "run_name": f"[{payload.robot_name}/{intent_module}] {clean_utterance[:55]}",
            "metadata": {
                "robot": payload.robot_name,
                "visitor": payload.recognised_name or "guest",
                "intent_module": intent_module,
                "risk_level": risk_level,
                "raw": payload.utterance,
                "compressed": clean_utterance,
                "auth_state": payload.auth_state,
                "clarification_count": payload.clarification_count,
            },
        },
    )
    timer.mark("llm_done")
    timer.log(log, "FRONTDESK")

    # Attach session state updates so frontend can echo them back
    decision.risk_level = risk_level
    decision.intent_module = intent_module
    decision.clarification_count = (
        payload.clarification_count + 1
        if decision.intent == "clarify"
        else 0  # reset counter on successful understanding
    )
    return _normalize_frontdesk_decision(decision, payload)


@router.post("/frontdesk", response_model=FrontDeskResponse)
def frontdesk_query(payload: FrontDeskRequest) -> FrontDeskResponse:
    """Understand a spoken lobby request and decide whether to keep talking or route."""
    log.info("\n" + "═" * 60)
    log.info("🏦 FRONTDESK  robot=%s  recognised=%s", payload.robot_name, payload.recognised_name or "none")
    log.info("   Visitor said: %r", payload.utterance)
    log.info("═" * 60)

    fallback = _fallback_frontdesk_response(payload)

    if not settings.openai_api_key:
        log.info("   ⚠️  No OpenAI key — using keyword fallback")
        return fallback

    try:
        result = _frontdesk_llm_call(payload)
        log.info("   🎯 Decision: route=%s  should_route=%s", result.route_target, result.should_route)
        log.info("   💬 Reply: %r", result.reply[:100])
        log.info("─" * 60)
        return result
    except Exception as e:
        log.warning("   ❌ Frontdesk LLM failed: %s — using fallback", e)
        return fallback
