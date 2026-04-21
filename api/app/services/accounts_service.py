from datetime import date, timedelta

from fastapi import HTTPException, status
from supabase import Client

from ..models.account import AccountCreate, AccountUpdate


def create_account(sb: Client, user_id: str, payload: AccountCreate) -> dict:
    row = payload.model_dump(mode="json")
    row["user_id"] = user_id
    res = sb.table("accounts").insert(row).execute()
    if not res.data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "insert failed")
    return res.data[0]


def get_account(sb: Client, user_id: str) -> dict:
    res = sb.table("accounts").select("*").eq("user_id", user_id).maybe_single().execute()
    if not res.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "account not found")
    return res.data


def update_account(sb: Client, user_id: str, payload: AccountUpdate) -> dict:
    patch = payload.model_dump(mode="json", exclude_none=True)
    if not patch:
        return get_account(sb, user_id)
    res = sb.table("accounts").update(patch).eq("user_id", user_id).execute()
    if not res.data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "account not found")
    return res.data[0]


def list_expenses(sb: Client, user_id: str, months: int = 3) -> list[dict]:
    since = (date.today() - timedelta(days=31 * months)).isoformat()
    res = (
        sb.table("expenses")
        .select("*")
        .eq("user_id", user_id)
        .gte("occurred_at", since)
        .order("occurred_at", desc=True)
        .execute()
    )
    return res.data or []
