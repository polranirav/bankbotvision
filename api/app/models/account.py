from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class AccountBase(BaseModel):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    address: str | None = None
    date_of_birth: date | None = None
    chequing_balance: Decimal = Decimal("0")
    savings_balance: Decimal = Decimal("0")
    credit_balance: Decimal = Decimal("0")
    credit_limit: Decimal = Decimal("0")
    credit_score: int | None = Field(default=None, ge=300, le=900)


class AccountCreate(AccountBase):
    """Payload for POST /accounts. user_id is taken from the JWT, not the body."""


class AccountUpdate(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    address: str | None = None
    date_of_birth: date | None = None
    chequing_balance: Decimal | None = None
    savings_balance: Decimal | None = None
    credit_balance: Decimal | None = None
    credit_limit: Decimal | None = None
    credit_score: int | None = Field(default=None, ge=300, le=900)


class Account(AccountBase):
    model_config = ConfigDict(from_attributes=True)

    user_id: str
    last_login_at: datetime | None = None
    last_login_loc: str | None = None
    face_image_path: str | None = None
    created_at: datetime
    updated_at: datetime


class Expense(BaseModel):
    id: int
    user_id: str
    category: str
    amount: Decimal
    occurred_at: date
    created_at: datetime
