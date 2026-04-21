from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import accounts as accounts_router
from .routers import auth as auth_router
from .routers import face as face_router
from .routers import health as health_router

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
