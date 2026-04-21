"""Auth helpers that bypass Supabase's email-confirmation flow for the demo.

We create users via the service-role admin client (auto-confirmed) and let the
browser obtain a session with signInWithPassword afterward.
"""
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from ..deps import SupabaseDep

router = APIRouter(prefix="/auth", tags=["auth"])


class SignupPayload(BaseModel):
    email: str
    password: str


class SignupResponse(BaseModel):
    user_id: str
    email: str


@router.post("/signup", response_model=SignupResponse, status_code=201)
def admin_signup(payload: SignupPayload, sb: SupabaseDep) -> SignupResponse:
    try:
        res = sb.auth.admin.create_user(
            {
                "email": payload.email,
                "password": payload.password,
                "email_confirm": True,
            }
        )
    except Exception as e:  # supabase-py raises AuthApiError on 4xx
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    user = getattr(res, "user", None)
    if not user:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "signup failed")
    return SignupResponse(user_id=user.id, email=user.email)
