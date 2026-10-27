"""AeroLab simulation backend.

Run from this directory:

    AEROLAB_COOKIE_SECURE=0 uv run uvicorn main:app --reload --port 8000

Interactive API documentation is served at /docs. Deployment settings (allowed origins, cookies, Mode C
limits, retention) are environment variables, listed in accounts/config.py.
"""

from __future__ import annotations

import threading
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from accounts import config
from accounts.cleanup import start_background_cleanup
from accounts.store import get_store
from api.auth import router as auth_router
from api.routes import BACKEND_VERSION, router
from engines.openfoam import find_launcher


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # Looking for OpenFOAM starts its session wrapper, which takes a few seconds the first time.
    # Do it in the background so the first status request is not held up by it.
    threading.Thread(target=find_launcher, name="openfoam-discovery", daemon=True).start()
    # Jobs live in memory: whatever was waiting or running when the server stopped will not finish.
    get_store().fail_unfinished("SERVER_RESTARTED", "The backend was restarted while this run was waiting or running. Run it again.")
    stop = threading.Event()
    start_background_cleanup(stop)
    yield
    stop.set()


app = FastAPI(
    title="AeroLab backend",
    version=BACKEND_VERSION,
    lifespan=lifespan,
    description=(
        "Aerodynamic simulation engines for the AeroLab virtual wind tunnel: analytical (Mode A), "
        "reduced-order potential flow (Mode B), an OpenFOAM adapter (Mode C) and an ML surrogate (Mode D). "
        "Educational / research-oriented; not a replacement for validated CFD."
    ),
)



@app.middleware("http")
async def check_origin(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Refuses changes requested by pages of other sites. The session cookie is SameSite, so this is a
    second line against cross-site requests; requests without an Origin (curl, scripts) are not browsers."""
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin.rstrip("/") not in config.allowed_origins():
        return JSONResponse(
            status_code=403, content={"detail": {"code": "ORIGIN_NOT_ALLOWED", "message": f"Requests from {origin} are not accepted."}}
        )
    return await call_next(request)


# Added last, so it wraps everything: refused requests still carry the CORS headers the browser needs to read them.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)

app.include_router(auth_router)
app.include_router(router)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "AeroLab backend", "docs": "/docs", "health": "/api/health"}
