from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _validate_pin(v: str | None) -> str | None:
    if v is None or v == "":
        return None
    if not v.isdigit() or len(v) != 4:
        raise ValueError("PIN must be exactly 4 digits")
    return v


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
    pin: str | None = None

    @field_validator("pin", mode="before")
    @classmethod
    def validate_pin(cls, v: str | None) -> str | None:
        return _validate_pin(v)


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
    pin: str | None = None

    @field_validator("pin", mode="before")
    @classmethod
    def validate_pin(cls, v: str | None) -> str | None:
        return _validate_pin(v)


class Account(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: str
    first_name: str
    last_name: str
    address: str | None = None
    date_of_birth: date | None = None
    chequing_balance: Decimal = Decimal("0")
    savings_balance: Decimal = Decimal("0")
    credit_balance: Decimal = Decimal("0")
    credit_limit: Decimal = Decimal("0")
    credit_score: int | None = None
    has_pin: bool = False          # true when a PIN is saved — never expose raw pin
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
