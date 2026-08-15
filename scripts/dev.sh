#!/bin/bash
# Dev mode: FastAPI with reload on :8000 + Vite dev server on :5173 (proxies /api)
set -e
cd "$(dirname "$0")/.."

uv run uvicorn app.main:app --app-dir backend --port 8000 --reload &
BACKEND_PID=$!
trap "kill $BACKEND_PID 2>/dev/null" EXIT

cd frontend && npm run dev
