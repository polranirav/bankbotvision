"""Phase 4 — Voice pipeline.

POST /voice/transcribe  — audio blob → text (Whisper via OpenAI)
POST /voice/speak       — text → MP3 audio stream (ElevenLabs)
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from openai import OpenAI
from pydantic import BaseModel

from ..config import settings

router = APIRouter(prefix="/voice", tags=["voice"])

_openai: OpenAI | None = None


def _get_openai() -> OpenAI:
    global _openai
    if _openai is None:
        _openai = OpenAI(api_key=settings.openai_api_key)
    return _openai


# ── Transcribe ────────────────────────────────────────────────────────────────

class TranscribeResponse(BaseModel):
    text: str


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(file: UploadFile = File(...)) -> TranscribeResponse:
    """Accept a WebM/OGG/MP4 audio blob and return the Whisper transcript."""
    audio_bytes = await file.read()
    if len(audio_bytes) < 1000:
        raise HTTPException(status_code=400, detail="Audio too short — nothing to transcribe")

    client = _get_openai()
    # Whisper needs a filename with an accepted extension so it knows the codec
    extension = (file.filename or "audio.webm").rsplit(".", 1)[-1] or "webm"
    transcript = client.audio.transcriptions.create(
        model="whisper-1",
        file=(f"audio.{extension}", audio_bytes, file.content_type or "audio/webm"),
    )
    return TranscribeResponse(text=transcript.text.strip())


# ── Speak ─────────────────────────────────────────────────────────────────────

class SpeakRequest(BaseModel):
    text: str
    voice_id: str | None = None  # override per-robot; falls back to settings default


@router.post("/speak")
async def speak(payload: SpeakRequest) -> StreamingResponse:
    """Convert text to speech with ElevenLabs and stream the MP3 back."""
    voice_id = payload.voice_id or settings.elevenlabs_voice_id
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"

    body = {
        "text": payload.text,
        "model_id": "eleven_turbo_v2",
        "voice_settings": {
            "stability": 0.45,
            "similarity_boost": 0.80,
            "style": 0.15,
            "use_speaker_boost": True,
        },
    }
    headers = {
        "xi-api-key": settings.elevenlabs_api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=body, headers=headers)

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs error {resp.status_code}: {resp.text[:200]}",
        )

    return StreamingResponse(
        iter([resp.content]),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-cache"},
    )
