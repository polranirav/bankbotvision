from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    supabase_url: str
    supabase_service_role_key: str
    api_cors_origins: str = "http://localhost:3000"

    # Phase 4 — Voice + Agent
    openai_api_key: str = ""
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"

    # STT engine: "local" (Faster-Whisper), "openai" (API), or "auto" (local→openai fallback)
    stt_engine: str = "auto"
    faster_whisper_model: str = "large-v3"   # tiny, base, small, medium, large-v3
    faster_whisper_device: str = "cpu"        # cpu or cuda
    faster_whisper_compute: str = "int8"      # int8, float16, float32

    # Face recognition (DeepFace)
    face_model: str = "Facenet512"        # Facenet512, VGG-Face, ArcFace, etc.
    face_detector: str = "retinaface"     # retinaface, opencv, mtcnn, ssd (mediapipe broken in v0.10+)
    face_match_threshold: float = 0.40    # cosine distance — lower = stricter

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.api_cors_origins.split(",") if o.strip()]

    @property
    def supabase_jwks_url(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"


settings = Settings()
