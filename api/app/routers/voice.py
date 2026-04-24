"""Phase 4 — Voice pipeline.

POST /voice/transcribe  — audio blob → text
                          Supports two engines:
                          • local  — Faster-Whisper (free, no API, handles accents)
                          • openai — OpenAI Whisper API (cloud)
                          • auto   — tries local first, falls back to openai
POST /voice/speak       — text → MP3 audio stream (ElevenLabs)
"""
from __future__ import annotations

import io
import logging
import tempfile
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from langsmith import traceable
from pydantic import BaseModel

from ..config import settings

router = APIRouter(prefix="/voice", tags=["voice"])
log = logging.getLogger("bankbot.voice")


# ── Lazy singletons ──────────────────────────────────────────────────────────

_openai_client = None
_whisper_model = None
_whisper_load_failed = False


def _get_openai():
    """Lazy-load the OpenAI client."""
    global _openai_client
    if _openai_client is None:
        from openai import OpenAI
        _openai_client = OpenAI(api_key=settings.openai_api_key)
    return _openai_client


def _get_whisper_model():
    """Lazy-load Faster-Whisper model (downloads weights on first call)."""
    global _whisper_model, _whisper_load_failed
    if _whisper_load_failed:
        return None
    if _whisper_model is not None:
        return _whisper_model
    try:
        from faster_whisper import WhisperModel
        log.info(
            "Loading Faster-Whisper model=%s device=%s compute=%s …",
            settings.faster_whisper_model,
            settings.faster_whisper_device,
            settings.faster_whisper_compute,
        )
        _whisper_model = WhisperModel(
            settings.faster_whisper_model,
            device=settings.faster_whisper_device,
            compute_type=settings.faster_whisper_compute,
        )
        log.info("Faster-Whisper model loaded successfully.")
        return _whisper_model
    except Exception as e:
        log.warning("Faster-Whisper failed to load: %s — will use OpenAI fallback", e)
        _whisper_load_failed = True
        return None


# ── Local transcription (Faster-Whisper) ─────────────────────────────────────

def _transcribe_local(audio_bytes: bytes, extension: str) -> str:
    """Transcribe audio using Faster-Whisper running locally."""
    model = _get_whisper_model()
    if model is None:
        raise RuntimeError("Faster-Whisper not available")

    # Faster-Whisper needs a file path, so write to a temp file
    suffix = f".{extension}" if extension else ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            beam_size=3,           # lower = faster, slightly less accurate
            language="en",         # constrain to English for speed
            vad_filter=True,       # skip silence segments
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=200,
                threshold=0.4
            ),
        )
        # Collect all segments into final text
        text_parts = [segment.text.strip() for segment in segments]
        transcript = " ".join(text_parts).strip()
        log.info(
            "Local transcription: lang=%s prob=%.2f duration=%.1fs → %d chars",
            info.language, info.language_probability,
            info.duration, len(transcript),
        )
        return transcript
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ── Cloud transcription (OpenAI Whisper) ─────────────────────────────────────

def _transcribe_openai(audio_bytes: bytes, extension: str) -> str:
    """Transcribe audio using the OpenAI Whisper API."""
    client = _get_openai()
    transcript = client.audio.transcriptions.create(
        model="whisper-1",
        file=(f"audio.{extension}", audio_bytes, f"audio/{extension}"),
    )
    return transcript.text.strip()


# ── Transcribe endpoint ──────────────────────────────────────────────────────

class TranscribeResponse(BaseModel):
    text: str
    engine: str = "unknown"   # which engine was actually used


@traceable(name="STT Transcription", run_type="chain")
def _run_transcription(audio_bytes: bytes, extension: str) -> dict:
    """Inner transcription logic — wrapped so LangSmith records the audio size,
    engine used, and the resulting transcript text."""
    engine = settings.stt_engine.lower().strip()

    if engine == "local":
        text = _transcribe_local(audio_bytes, extension)
        return {"transcript": text, "engine": "faster-whisper", "audio_bytes": len(audio_bytes)}

    if engine == "openai":
        if not settings.openai_api_key:
            raise RuntimeError("OpenAI key not configured")
        text = _transcribe_openai(audio_bytes, extension)
        return {"transcript": text, "engine": "openai-whisper", "audio_bytes": len(audio_bytes)}

    # auto — local first, fallback to openai
    try:
        text = _transcribe_local(audio_bytes, extension)
        return {"transcript": text, "engine": "faster-whisper", "audio_bytes": len(audio_bytes)}
    except Exception as local_err:
        log.info("Local STT failed (%s), falling back to OpenAI", local_err)
        if not settings.openai_api_key:
            raise RuntimeError("Local STT unavailable and no OpenAI key configured")
        text = _transcribe_openai(audio_bytes, extension)
        return {"transcript": text, "engine": "openai-whisper", "audio_bytes": len(audio_bytes)}


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(file: UploadFile = File(...)) -> TranscribeResponse:
    """Accept a WebM/OGG/MP4 audio blob and return the transcript."""
    audio_bytes = await file.read()
    if len(audio_bytes) < 1000:
        raise HTTPException(status_code=400, detail="Audio too short — nothing to transcribe")

    extension = (file.filename or "audio.webm").rsplit(".", 1)[-1] or "webm"

    try:
        result = _run_transcription(audio_bytes, extension)
        return TranscribeResponse(text=result["transcript"], engine=result["engine"])
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"STT failed: {e}")


# ── Speak endpoint ────────────────────────────────────────────────────────────

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
