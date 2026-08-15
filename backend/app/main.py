from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, db
from .api import albums, dupes, events, jobs, media, people, places, roots, system, timeline, volumes


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    from .jobs.runner import manager

    config.ensure_dirs()
    db.connect()
    manager.set_loop(asyncio.get_running_loop())
    yield
    db.close()


app = FastAPI(title="Photos Organizer", lifespan=lifespan)

for r in (system, volumes, roots, jobs, timeline, media, people, places, albums, events, dupes):
    app.include_router(r.router, prefix="/api")

# Production: serve the built frontend (dev uses the Vite server + /api proxy)
if (config.FRONTEND_DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    # The shell must always revalidate: hashed assets change name every build,
    # so a cached index.html would keep loading a stale bundle forever.
    _NO_CACHE = {"Cache-Control": "no-cache, must-revalidate"}

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        candidate = config.FRONTEND_DIST / path
        if path and candidate.is_file():
            headers = _NO_CACHE if candidate.name == "index.html" else None
            return FileResponse(candidate, headers=headers)
        return FileResponse(config.FRONTEND_DIST / "index.html", headers=_NO_CACHE)
