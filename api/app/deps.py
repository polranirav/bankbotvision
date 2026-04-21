import time
from functools import lru_cache
from typing import Annotated, Any

import httpx
from fastapi import Depends, Header, HTTPException, status
from jose import JWTError, jwt
from supabase import Client, create_client

from .config import settings


@lru_cache(maxsize=1)
def get_supabase() -> Client:
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


# Simple JWKS cache. Supabase now signs access tokens with ES256 and publishes
# the public key at /auth/v1/.well-known/jwks.json — we fetch once and reuse.
_JWKS_CACHE: dict[str, Any] = {"keys": None, "fetched_at": 0.0}
_JWKS_TTL_SECONDS = 3600


def _get_jwks() -> list[dict[str, Any]]:
    now = time.time()
    if _JWKS_CACHE["keys"] and now - _JWKS_CACHE["fetched_at"] < _JWKS_TTL_SECONDS:
        return _JWKS_CACHE["keys"]
    resp = httpx.get(settings.supabase_jwks_url, timeout=5.0)
    resp.raise_for_status()
    keys = resp.json().get("keys", [])
    _JWKS_CACHE["keys"] = keys
    _JWKS_CACHE["fetched_at"] = now
    return keys


def _find_key(kid: str) -> dict[str, Any] | None:
    for key in _get_jwks():
        if key.get("kid") == kid:
            return key
    # Retry once with a forced refresh in case Supabase rotated the key.
    _JWKS_CACHE["fetched_at"] = 0
    for key in _get_jwks():
        if key.get("kid") == kid:
            return key
    return None


def get_current_user_id(
    authorization: Annotated[str | None, Header()] = None,
) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.split(" ", 1)[1]

    try:
        header = jwt.get_unverified_header(token)
    except JWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token header: {e}")

    alg = header.get("alg")
    kid = header.get("kid")
    if not alg or not kid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token missing alg/kid")

    key = _find_key(kid)
    if key is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unknown signing key")

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=[alg],
            audience="authenticated",
        )
    except JWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {e}")

    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token missing sub claim")
    return user_id


CurrentUserId = Annotated[str, Depends(get_current_user_id)]
SupabaseDep = Annotated[Client, Depends(get_supabase)]
