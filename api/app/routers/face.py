"""Face recognition endpoints — server-side DeepFace + MediaPipe.

POST   /face/detect   — accept a JPEG image, detect + identify the face (no auth)
POST   /face/save     — accept a JPEG image, generate embedding, store (requires auth)
POST   /face/match    — legacy descriptor-based match (backward compat)
DELETE /face/delete   — remove face descriptor + image for current user (requires auth)
"""
from __future__ import annotations

import base64
import io
import logging
import tempfile
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, File, status
from pydantic import BaseModel

from ..config import settings
from ..deps import CurrentUserId, SupabaseDep, get_supabase

router = APIRouter(prefix="/face", tags=["face"])
log = logging.getLogger("bankbot.face")

BUCKET = "face_images"


# ── Lazy DeepFace loading ────────────────────────────────────────────────────

_deepface_ready = False
_deepface_failed = False


def _ensure_deepface():
    """Warm up DeepFace models on first call."""
    global _deepface_ready, _deepface_failed
    if _deepface_ready:
        return
    if _deepface_failed:
        raise RuntimeError("DeepFace failed to initialize")
    try:
        from deepface import DeepFace
        # Warm up — this downloads model weights on first run
        log.info(
            "Warming up DeepFace: model=%s detector=%s",
            settings.face_model, settings.face_detector,
        )
        # Build model once (downloads weights if needed)
        DeepFace.build_model(settings.face_model)
        _deepface_ready = True
        log.info("DeepFace ready.")
    except Exception as e:
        _deepface_failed = True
        log.error("DeepFace init failed: %s", e)
        raise


def _get_embedding(image_path: str) -> list[float]:
    """Generate a face embedding from an image file using DeepFace."""
    _ensure_deepface()
    from deepface import DeepFace

    results = DeepFace.represent(
        img_path=image_path,
        model_name=settings.face_model,
        detector_backend=settings.face_detector,
        enforce_detection=True,
    )
    if not results:
        raise ValueError("No face detected in image")
    # Return the first face's embedding
    return results[0]["embedding"]


def _get_embedding_no_enforce(image_path: str) -> list[float] | None:
    """Generate a face embedding, returning None if no face found."""
    _ensure_deepface()
    from deepface import DeepFace

    try:
        results = DeepFace.represent(
            img_path=image_path,
            model_name=settings.face_model,
            detector_backend=settings.face_detector,
            enforce_detection=False,
        )
        if not results or not results[0].get("embedding"):
            return None
        # Check face confidence — skip if too low
        face_conf = results[0].get("face_confidence", 0)
        if face_conf < 0.5:
            return None
        return results[0]["embedding"]
    except Exception:
        return None


def _cosine_distance(a: list[float], b: list[float]) -> float:
    """Cosine distance between two vectors (0 = identical, 2 = opposite)."""
    va = np.array(a)
    vb = np.array(b)
    dot = np.dot(va, vb)
    norm = np.linalg.norm(va) * np.linalg.norm(vb)
    if norm == 0:
        return 2.0
    return 1.0 - (dot / norm)


def _save_temp_image(data: bytes, suffix: str = ".jpg") -> str:
    """Write bytes to a temp file and return the path."""
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        return f.name


# ── Pydantic models ──────────────────────────────────────────────────────────

class DetectRequest(BaseModel):
    """Base64-encoded JPEG image for detection."""
    image_data_url: str   # data:image/jpeg;base64,<...> or raw base64


class DetectResponse(BaseModel):
    detected: bool
    matched: bool = False
    user_id: str | None = None
    first_name: str | None = None
    magic_link: str | None = None
    confidence: float = 0.0


class SaveFacePayload(BaseModel):
    image_data_url: str   # data:image/jpeg;base64,<...>


class LegacyMatchPayload(BaseModel):
    """Backward-compatible 128-dim descriptor match."""
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


def _generate_magic_link(sb, user_id: str) -> str:
    """Generate a Supabase magic link for the matched user."""
    user_res = sb.auth.admin.get_user_by_id(user_id)
    user_email = user_res.user.email
    link_res = sb.auth.admin.generate_link({
        "type": "magiclink",
        "email": user_email,
        "options": {"redirect_to": "http://localhost:3000/account"},
    })
    return link_res.properties.action_link


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/detect", response_model=DetectResponse)
def detect_face(payload: DetectRequest) -> DetectResponse:
    """Accept a JPEG image, detect face, and try to match against stored users.

    This is the primary endpoint for the lobby — the browser sends a webcam
    frame and the server does ALL the ML work.
    """
    img_bytes = _data_url_to_bytes(payload.image_data_url)
    if len(img_bytes) < 500:
        return DetectResponse(detected=False)

    tmp_path = _save_temp_image(img_bytes)
    try:
        embedding = _get_embedding_no_enforce(tmp_path)
        if embedding is None:
            return DetectResponse(detected=False)

        # Face detected — try to match against registered users
        sb = get_supabase()
        res = sb.table("accounts").select(
            "user_id, first_name, face_descriptor"
        ).not_.is_("face_descriptor", "null").execute()

        rows = res.data or []
        if not rows:
            return DetectResponse(detected=True, matched=False)

        # Find closest match using cosine distance
        best_user = None
        best_dist = float("inf")
        for row in rows:
            stored = row["face_descriptor"]
            if not stored or len(stored) != len(embedding):
                continue  # skip incompatible descriptors (old 128-dim vs new 512-dim)
            dist = _cosine_distance(embedding, stored)
            if dist < best_dist:
                best_dist = dist
                best_user = row

        if best_user is not None:
            log.info(f"[FACE] Best match distance: {best_dist}")
            print(f"[FACE] Best match distance: {best_dist}")

        if best_dist > settings.face_match_threshold or best_user is None:
            return DetectResponse(
                detected=True,
                matched=False,
                confidence=round(1.0 - best_dist, 3) if best_dist < 2.0 else 0.0,
            )

        # Match found — generate magic link
        try:
            magic_link = _generate_magic_link(sb, best_user["user_id"])
        except Exception as e:
            log.warning("Magic link generation failed: %s", e)
            magic_link = None

        return DetectResponse(
            detected=True,
            matched=True,
            user_id=best_user["user_id"],
            first_name=best_user["first_name"],
            magic_link=magic_link,
            confidence=round(1.0 - best_dist, 3),
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)


@router.post("/save", status_code=200)
def save_face(
    payload: SaveFacePayload,
    user_id: CurrentUserId,
    sb: SupabaseDep,
) -> dict:
    """Accept a JPEG image, compute embedding server-side, and store both."""
    img_bytes = _data_url_to_bytes(payload.image_data_url)
    if len(img_bytes) < 500:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Image too small")

    # Generate embedding using DeepFace
    tmp_path = _save_temp_image(img_bytes)
    try:
        embedding = _get_embedding(tmp_path)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    except RuntimeError as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e))
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    # Upload image to Supabase Storage
    storage_path = f"{user_id}/face.jpg"
    sb.storage.from_(BUCKET).upload(
        path=storage_path,
        file=img_bytes,
        file_options={"content-type": "image/jpeg", "upsert": "true"},
    )

    # Save embedding + image path
    sb.table("accounts").update({
        "face_descriptor": embedding,
        "face_image_path": storage_path,
    }).eq("user_id", user_id).execute()

    return {"ok": True, "embedding_dim": len(embedding)}


@router.delete("/delete")
def delete_face(user_id: CurrentUserId, sb: SupabaseDep):
    """Remove the current user's face descriptor and stored image."""
    # Fetch existing image path so we can delete from Storage
    res = sb.table("accounts").select("face_image_path").eq("user_id", user_id).single().execute()
    row = res.data or {}
    storage_path: str | None = row.get("face_image_path")

    # Remove from Storage bucket if present
    if storage_path:
        try:
            sb.storage.from_(BUCKET).remove([storage_path])
        except Exception as exc:
            log.warning("Could not delete face image from storage: %s", exc)

    # Clear DB fields
    sb.table("accounts").update({
        "face_descriptor": None,
        "face_image_path": None,
    }).eq("user_id", user_id).execute()

    return {"ok": True}


@router.post("/match", response_model=MatchFaceResponse)
def match_face(payload: LegacyMatchPayload, sb: SupabaseDep) -> MatchFaceResponse:
    """Legacy endpoint — match using a pre-computed descriptor array.

    Kept for backward compatibility. New clients should use POST /face/detect.
    """
    if len(payload.descriptor) not in (128, 512):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "descriptor must be 128 or 512 floats",
        )

    res = sb.table("accounts").select(
        "user_id, first_name, face_descriptor"
    ).not_.is_("face_descriptor", "null").execute()

    rows = res.data or []
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No registered faces found")

    best_user = None
    best_dist = float("inf")
    for row in rows:
        stored = row["face_descriptor"]
        if not stored or len(stored) != len(payload.descriptor):
            continue
        dist = _cosine_distance(payload.descriptor, stored)
        if dist < best_dist:
            best_dist = dist
            best_user = row

    if best_dist > settings.face_match_threshold or best_user is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            f"Face not recognised (distance={best_dist:.3f})",
        )

    magic_link = _generate_magic_link(sb, best_user["user_id"])

    return MatchFaceResponse(
        user_id=best_user["user_id"],
        first_name=best_user["first_name"],
        magic_link=magic_link,
    )
