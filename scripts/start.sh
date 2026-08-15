#!/bin/bash
# Production-ish: build the frontend once, then serve everything from FastAPI at :8000
set -e
cd "$(dirname "$0")/.."

if [ ! -f frontend/dist/index.html ] || [ "$1" == "--build" ]; then
  (cd frontend && npm run build)
fi

exec uv run uvicorn app.main:app --app-dir backend --port 8000
