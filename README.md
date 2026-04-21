# BankBot Vision

A prototype virtual bank where animated robots greet customers by face and converse with them about their accounts through live voice. **Prototype for demo purposes only — not a real bank.**

This repo is at **Phase 1 (Foundation)**: account signup, email/password auth, CRUD over CIBC-style account data. Face recognition, 3D robots, and voice are wired in later phases.

## Stack

- **web/** — Next.js (App Router, TypeScript, Tailwind)
- **api/** — FastAPI (Python 3.11+)
- **db/** — Supabase (Postgres + Auth + Storage). SQL in `db/` is the source of truth.

## Setup

### 1. Supabase

Create a Supabase project. In the SQL editor, run in order:

```
db/schema.sql
db/policies.sql
db/seed.sql   # optional demo users
```

Grab the project URL, `anon` key, and `service_role` key from Project Settings → API.

### 2. Backend (`api/`)

```bash
cd api
cp .env.example .env
# fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
uv sync                               # or: pip install -e .
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Health check: `curl http://localhost:8000/api/v1/health`.

### 3. Frontend (`web/`)

```bash
cd web
cp .env.local.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# and NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api/v1
pnpm install
pnpm dev                              # serves http://localhost:3000
```

## Verification

1. Visit http://localhost:3000/signup, create an account with the CIBC-style form.
2. Check the `accounts` row appears in Supabase.
3. Log out, log back in at `/login`, view `/account`.
4. `cd api && uv run pytest` — CRUD tests pass.

## Roadmap

- **Phase 2 — Face:** face-api.js capture on signup, face-match login.
- **Phase 3 — Robots:** Three.js + Ready Player Me scene on landing.
- **Phase 4 — Voice + Agent:** Whisper STT → GPT-4 → ElevenLabs TTS, LangChain agent over account + expenses tables.
