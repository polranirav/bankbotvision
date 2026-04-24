import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings

# ── LangSmith tracing — must be set in os.environ before LangChain imports ───
# pydantic-settings loads .env but LangChain reads os.environ directly.
if settings.langchain_api_key:
    os.environ.setdefault("LANGCHAIN_TRACING_V2", settings.langchain_tracing_v2)
    os.environ.setdefault("LANGCHAIN_ENDPOINT", settings.langchain_endpoint)
    os.environ.setdefault("LANGCHAIN_API_KEY", settings.langchain_api_key)
    os.environ.setdefault("LANGCHAIN_PROJECT", settings.langchain_project)

from .routers import accounts as accounts_router
from .routers import agent as agent_router
from .routers import auth as auth_router
from .routers import face as face_router
from .routers import health as health_router
from .routers import voice as voice_router

# ── Logging ──────────────────────────────────────────────────────────────────
# Show all bankbot.* logs (agent, voice, face) in the terminal
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
)
# Set bankbot loggers to INFO
for name in ("bankbot.agent", "bankbot.voice", "bankbot.face"):
    logging.getLogger(name).setLevel(logging.INFO)

app = FastAPI(title="BankBot Vision API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_PREFIX = "/api/v1"
app.include_router(health_router.router, prefix=API_PREFIX)
app.include_router(auth_router.router, prefix=API_PREFIX)
app.include_router(face_router.router, prefix=API_PREFIX)
app.include_router(accounts_router.router, prefix=API_PREFIX)
app.include_router(accounts_router.expenses_router, prefix=API_PREFIX)
app.include_router(voice_router.router, prefix=API_PREFIX)
app.include_router(agent_router.router, prefix=API_PREFIX)
