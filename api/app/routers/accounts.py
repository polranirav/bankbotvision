from fastapi import APIRouter, Query

from ..deps import CurrentUserId, SupabaseDep
from ..models.account import Account, AccountCreate, AccountUpdate, Expense
from ..services import accounts_service

router = APIRouter(prefix="/accounts", tags=["accounts"])


@router.post("", response_model=Account, status_code=201)
def create_account(
    payload: AccountCreate,
    user_id: CurrentUserId,
    sb: SupabaseDep,
) -> dict:
    return accounts_service.create_account(sb, user_id, payload)


@router.get("/me", response_model=Account)
def get_my_account(user_id: CurrentUserId, sb: SupabaseDep) -> dict:
    return accounts_service.get_account(sb, user_id)


@router.put("/me", response_model=Account)
def update_my_account(
    payload: AccountUpdate,
    user_id: CurrentUserId,
    sb: SupabaseDep,
) -> dict:
    return accounts_service.update_account(sb, user_id, payload)


expenses_router = APIRouter(prefix="/expenses", tags=["expenses"])


@expenses_router.get("/me", response_model=list[Expense])
def list_my_expenses(
    user_id: CurrentUserId,
    sb: SupabaseDep,
    months: int = Query(default=3, ge=1, le=24),
) -> list[dict]:
    return accounts_service.list_expenses(sb, user_id, months=months)
