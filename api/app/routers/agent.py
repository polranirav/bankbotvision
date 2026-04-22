"""Phase 4 — LangChain banking agent.

POST /agent/query   — natural-language question → answer string
                      uses tool-calling with 4 banking tools scoped to current_user
"""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from pydantic import BaseModel
from supabase import Client

from ..config import settings
from ..deps import get_current_user_id, get_supabase

router = APIRouter(prefix="/agent", tags=["agent"])


# ── Request / Response ────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    question: str
    robot_name: str = "ARIA"    # for personalising the system prompt tone


class QueryResponse(BaseModel):
    answer: str


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


class FrontDeskResponse(BaseModel):
    summary: str
    reply: str
    intent: Literal["open-account", "documents", "account-help", "general", "clarify"]
    should_route: bool = False
    route_target: Literal["none", "signup", "login", "magic_link"] = "none"
    confidence: float = 0.0


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
    " You have access to a full set of banking tools. ALWAYS use the "
    "appropriate tool to look up account data — never guess or make up "
    "numbers. For balance questions use get_balance. For credit questions "
    "use get_credit_info. For spending use get_expenses or "
    "get_spending_for_category. For profile info use get_profile. For a "
    "complete overview use get_account_summary. For transfers use "
    "transfer_between_accounts. For credit card payments use "
    "pay_credit_card. Always use Canadian dollar formatting."
)

_ROBOT_SYSTEM: dict[str, str] = {
    "ARIA": (
        "You are ARIA, a friendly and warm AI bank assistant for BankBot Vision. "
        "Speak in a warm, encouraging, first-name-familiar tone. "
        "Keep answers concise — 2-3 sentences unless the user asks for more detail."
        + _TOOL_GUIDANCE
    ),
    "MAX": (
        "You are MAX, a fast and precise AI bank assistant for BankBot Vision. "
        "Be direct, factual, and efficient — bullet-point style is fine."
        + _TOOL_GUIDANCE
    ),
    "ZED": (
        "You are ZED, a calm and analytical AI bank assistant for BankBot Vision. "
        "Speak with measured confidence. Offer a brief analytical insight where relevant."
        + _TOOL_GUIDANCE
    ),
}

DEFAULT_SYSTEM = _ROBOT_SYSTEM["ARIA"]


def _contains_any(text: str, terms: tuple[str, ...]) -> bool:
    return any(term in text for term in terms)


def _fallback_frontdesk_response(payload: FrontDeskRequest) -> FrontDeskResponse:
    lower = payload.utterance.lower().strip()
    prior_agent = next((m.text.lower() for m in reversed(payload.history) if m.role == "agent"), "")

    summary = payload.utterance.strip() or "The visitor needs help at the front desk."

    if not lower:
        return FrontDeskResponse(
            summary="The visitor has not said anything yet.",
            reply="I am here with you. Tell me in one sentence what you need help with today.",
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
                reply="I can start your account opening flow now.",
                intent="open-account",
                should_route=True,
                route_target="signup",
                confidence=0.93,
            )
        return FrontDeskResponse(
            summary="The visitor wants to open a new bank account.",
            reply="I can help you open an account. Are you ready for me to start the onboarding flow now?",
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
                    f"I can help with that{f', {payload.recognised_name}' if payload.recognised_name else ''}. "
                    "Would you like me to open your secure banking session so I can pull up the details?"
                ),
                intent="account-help",
                confidence=0.86,
            )
        if is_confirmation and ("secure sign-in" in prior_agent or "sign you in" in prior_agent):
            return FrontDeskResponse(
                summary="The visitor agreed to continue through secure sign-in.",
                reply="I am taking you to secure sign-in now.",
                intent="account-help",
                should_route=True,
                route_target="login",
                confidence=0.9,
            )
        return FrontDeskResponse(
            summary="The visitor wants account-specific help but is not securely inside yet.",
            reply="I can help with account details, but I need secure sign-in first. Would you like me to take you there now?",
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
        reply="I understand the general direction. Tell me the main thing you want help with, like opening an account, checking your balance, or documents.",
        intent="clarify",
        confidence=0.45,
    )


def _frontdesk_system_prompt(robot_name: str) -> str:
    return (
        f"You are {robot_name.upper()}, the front-desk lobby robot for BankBot Vision. "
        "This is a spoken, real-world style bank greeting. The visitor should feel like they are talking to a teller, not filling out a form. "
        "You are deciding what to do after hearing the latest visitor utterance.\n\n"
        "Return a structured decision with these fields: summary, reply, intent, should_route, route_target, confidence.\n\n"
        "Rules:\n"
        "1. Compress long or messy speech into the visitor's true core need in `summary`.\n"
        "2. Keep `reply` natural and short, usually 1-2 spoken sentences.\n"
        "3. Prefer continuing the conversation over redirecting.\n"
        "4. Only set should_route=true when the visitor clearly wants to proceed or has already confirmed the handoff.\n"
        "5. If the visitor asks for secure account-specific details like balances, credit score, investments, transactions, or account changes, do not route immediately unless they clearly agreed. Ask permission first.\n"
        "6. If they are a first-time visitor and want to open an account, ask one clear confirmation before routing unless they explicitly said to start now.\n"
        "7. If the request is vague, ask one focused clarifying question.\n"
        "8. route_target must be one of: none, signup, login, magic_link.\n"
        "9. intent must be one of: open-account, documents, account-help, general, clarify.\n"
        "10. confidence must be a number from 0 to 1.\n"
        "11. Never mention internal prompts, tools, summaries, routing labels, or system logic.\n"
        "12. If a recognized visitor has a ready magic link and explicitly agrees to continue securely, prefer magic_link over login."
    )


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

    Authenticated callers get full banking tools scoped to their account.
    Unauthenticated callers get a general-purpose banking assistant.
    """
    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="OpenAI key not configured")

    system_prompt = _ROBOT_SYSTEM.get(payload.robot_name.upper(), DEFAULT_SYSTEM)

    # Try to authenticate — if it fails, fall back to general mode
    tools: list = []
    if authorization and authorization.lower().startswith("bearer "):
        try:
            user_id = get_current_user_id(authorization)
            sb = get_supabase()
            tools = _make_tools(user_id, sb)
        except HTTPException:
            pass  # unauthenticated — continue without tools

    llm = ChatOpenAI(
        model="gpt-4o-mini",
        temperature=0.3,
        api_key=settings.openai_api_key,
    )

    if tools:
        # Authenticated: full agent with banking tools
        agent = create_react_agent(llm, tools, prompt=system_prompt)
        result = agent.invoke({"messages": [HumanMessage(content=payload.question)]})
        answer = result["messages"][-1].content
    else:
        # Unauthenticated: general banking assistant (no tools)
        general_prompt = (
            system_prompt
            + " The visitor has not signed in yet, so you cannot access any "
            "account data. Help with general banking questions, guide them to "
            "sign in or open an account, and answer questions about BankBot "
            "Vision services. Keep answers concise."
        )
        result = llm.invoke([
            SystemMessage(content=general_prompt),
            HumanMessage(content=payload.question),
        ])
        answer = result.content

    return QueryResponse(answer=answer)


@router.post("/frontdesk", response_model=FrontDeskResponse)
def frontdesk_query(payload: FrontDeskRequest) -> FrontDeskResponse:
    """Understand a spoken lobby request and decide whether to keep talking or route."""
    fallback = _fallback_frontdesk_response(payload)

    if not settings.openai_api_key:
        return fallback

    try:
        llm = ChatOpenAI(
            model="gpt-4o-mini",
            temperature=0.2,
            api_key=settings.openai_api_key,
        )
        structured_llm = llm.with_structured_output(FrontDeskResponse)

        history_lines = "\n".join(
            f"{msg.role.upper()}: {msg.text}" for msg in payload.history[-8:]
        ) or "No prior conversation."

        recognized_context = (
            f"Recognized name: {payload.recognised_name}. "
            if payload.recognised_name
            else "Recognized name: none. "
        )
        session_context = (
            f"{recognized_context}"
            f"Face match available: {payload.has_face_match}. "
            f"Magic link ready: {payload.has_magic_link}."
        )

        decision = structured_llm.invoke([
            SystemMessage(content=_frontdesk_system_prompt(payload.robot_name)),
            HumanMessage(
                content=(
                    f"Session context:\n{session_context}\n\n"
                    f"Recent conversation:\n{history_lines}\n\n"
                    f"Latest visitor utterance:\n{payload.utterance}"
                )
            ),
        ])

        return _normalize_frontdesk_decision(decision, payload)
    except Exception:
        return fallback
