"""Face recognition endpoints.

POST /face/save   — save descriptor + image for the current user (requires auth)
POST /face/match  — identify a face from descriptor, return a magic-link session (no auth)
"""
import base64
import io

import numpy as np
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from ..deps import CurrentUserId, SupabaseDep

router = APIRouter(prefix="/face", tags=["face"])

MATCH_THRESHOLD = 0.5   # Euclidean distance — lower = stricter
BUCKET = "face_images"


# ── Pydantic models ─────────────────────────────────────────────────────────

class SaveFacePayload(BaseModel):
    descriptor: list[float]          # 128-dim vector from face-api.js
    image_data_url: str              # data:image/jpeg;base64,<...>


class MatchFacePayload(BaseModel):
    descriptor: list[float]


class MatchFaceResponse(BaseModel):
    user_id: str
    first_name: str
    magic_link: str


# ── Helpers ──────────────────────────────────────────────────────────────────

def _data_url_to_bytes(data_url: str) -> bytes:
    """Strip the data:image/jpeg;base64, header and decode."""
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    return base64.b64decode(data_url)


def _euclidean(a: list[float], b: list[float]) -> float:
    return float(np.linalg.norm(np.array(a) - np.array(b)))


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/save", status_code=200)
def save_face(
    payload: SaveFacePayload,
    user_id: CurrentUserId,
    sb: SupabaseDep,
) -> dict:
    if len(payload.descriptor) != 128:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "descriptor must be 128 floats")

    # Upload image to Supabase Storage
    img_bytes = _data_url_to_bytes(payload.image_data_url)
    storage_path = f"{user_id}/face.jpg"
    sb.storage.from_(BUCKET).upload(
        path=storage_path,
        file=img_bytes,
        file_options={"content-type": "image/jpeg", "upsert": "true"},
    )

    # Save descriptor + image path to accounts table
    sb.table("accounts").update({
        "face_descriptor": payload.descriptor,
        "face_image_path": storage_path,
    }).eq("user_id", user_id).execute()

    return {"ok": True}


@router.post("/match", response_model=MatchFaceResponse)
def match_face(payload: MatchFacePayload, sb: SupabaseDep) -> MatchFaceResponse:
    if len(payload.descriptor) != 128:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "descriptor must be 128 floats")

    # Fetch all registered descriptors (only users who completed face signup)
    res = sb.table("accounts").select(
        "user_id, first_name, face_descriptor"
    ).not_.is_("face_descriptor", "null").execute()

    rows = res.data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No registered faces found")

    # Find closest match
    best_user = None
    best_dist = float("inf")
    for row in rows:
        dist = _euclidean(payload.descriptor, row["face_descriptor"])
        if dist < best_dist:
            best_dist = dist
            best_user = row

    if best_dist > MATCH_THRESHOLD or best_user is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            f"Face not recognised (distance={best_dist:.3f})"
        )

    # Generate a magic link so the browser can establish a real Supabase session
    user_res = sb.auth.admin.get_user_by_id(best_user["user_id"])
    user_email = user_res.user.email

    link_res = sb.auth.admin.generate_link({
        "type": "magiclink",
        "email": user_email,
        "options": {"redirect_to": "http://localhost:3000/account"},
    })
    magic_link = link_res.properties.action_link

    return MatchFaceResponse(
        user_id=best_user["user_id"],
        first_name=best_user["first_name"],
        magic_link=magic_link,
    )
