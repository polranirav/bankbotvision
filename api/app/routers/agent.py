"""Phase 4 — LangChain banking agent.

POST /agent/query   — natural-language question → answer string
                      uses tool-calling with 4 banking tools scoped to current_user
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException
from langchain_core.messages import HumanMessage
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


# ── LangChain Tools (injected with user_id + supabase at call time) ───────────

def _make_tools(user_id: str, sb: Client):
    """Return four banking tools closed over the authenticated user."""

    @tool
    def get_balance(_: str = "") -> str:
        """Return the user's current chequing, savings, and credit balances."""
        res = (
            sb.table("accounts")
            .select("first_name,chequing_balance,savings_balance,credit_balance,credit_limit")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        return (
            f"Name: {d['first_name']}\n"
            f"Chequing: ${d['chequing_balance']:,.2f}\n"
            f"Savings: ${d['savings_balance']:,.2f}\n"
            f"Credit used: ${d['credit_balance']:,.2f} / ${d['credit_limit']:,.2f}"
        )

    @tool
    def get_expenses(months: str = "3") -> str:
        """Return the user's recent expenses grouped by category for the given number of months."""
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
        # group by category
        totals: dict[str, float] = {}
        for r in rows:
            totals[r["category"]] = totals.get(r["category"], 0) + float(r["amount"])
        lines = "\n".join(f"  {cat}: ${amt:,.2f}" for cat, amt in sorted(totals.items(), key=lambda x: -x[1]))
        total = sum(totals.values())
        return f"Expenses last {m} month(s):\n{lines}\n  TOTAL: ${total:,.2f}"

    @tool
    def get_credit_info(_: str = "") -> str:
        """Return the user's credit score and credit utilisation ratio."""
        res = (
            sb.table("accounts")
            .select("credit_score,credit_balance,credit_limit")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        score = d["credit_score"] or "N/A"
        used = float(d["credit_balance"] or 0)
        limit = float(d["credit_limit"] or 0)
        utilisation = f"{used / limit * 100:.1f}%" if limit > 0 else "N/A"
        return (
            f"Credit score: {score}\n"
            f"Credit utilisation: {utilisation} (${used:,.2f} of ${limit:,.2f})"
        )

    @tool
    def get_last_login(_: str = "") -> str:
        """Return when and where the user last logged in."""
        res = (
            sb.table("accounts")
            .select("last_login_at,last_login_loc")
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not res.data:
            return "Account not found."
        d = res.data
        at = d.get("last_login_at") or "unknown"
        loc = d.get("last_login_loc") or "unknown location"
        return f"Last login: {at} from {loc}"

    return [get_balance, get_expenses, get_credit_info, get_last_login]


# ── Agent personalities ───────────────────────────────────────────────────────

_ROBOT_SYSTEM: dict[str, str] = {
    "ARIA": (
        "You are ARIA, a friendly and warm AI bank assistant for BankBot Vision. "
        "Speak in a warm, encouraging, first-name-familiar tone. "
        "Keep answers concise — 2-3 sentences unless the user asks for more detail. "
        "Always use Canadian dollar formatting. Never make up numbers; use the tools."
    ),
    "MAX": (
        "You are MAX, a fast and precise AI bank assistant for BankBot Vision. "
        "Be direct, factual, and efficient — bullet-point style is fine. "
        "Always use Canadian dollar formatting. Never make up numbers; use the tools."
    ),
    "ZED": (
        "You are ZED, a calm and analytical AI bank assistant for BankBot Vision. "
        "Speak with measured confidence. Offer a brief analytical insight where relevant. "
        "Always use Canadian dollar formatting. Never make up numbers; use the tools."
    ),
}

DEFAULT_SYSTEM = _ROBOT_SYSTEM["ARIA"]


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/query", response_model=QueryResponse)
def agent_query(
    payload: QueryRequest,
    authorization: Annotated[str | None, Header()] = None,
) -> QueryResponse:
    """Run the banking agent and return a natural-language answer."""
    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="OpenAI key not configured")

    user_id = get_current_user_id(authorization)
    sb = get_supabase()

    system_prompt = _ROBOT_SYSTEM.get(payload.robot_name.upper(), DEFAULT_SYSTEM)
    tools = _make_tools(user_id, sb)

    llm = ChatOpenAI(
        model="gpt-4o-mini",
        temperature=0.3,
        api_key=settings.openai_api_key,
    )

    agent = create_react_agent(llm, tools, prompt=system_prompt)
    result = agent.invoke({"messages": [HumanMessage(content=payload.question)]})

    # Last message is the assistant's final reply
    answer = result["messages"][-1].content
    return QueryResponse(answer=answer)
