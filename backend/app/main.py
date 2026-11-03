import logging

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api import auth, business, customers, debts, integrations, payments, reminders, reports, sync
from app.config import get_settings
from app.db import engine
from app.errors import install_error_handlers
from app.integrations.mpesa import get_mpesa


class _RedactingFilter(logging.Filter):
    """Belt-and-braces: never let obvious secrets reach the logs."""

    KEYS = ("password", "authorization", "refresh_token", "access_token", "api_key", "passkey")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = str(record.msg).lower()
        if any(k in msg for k in self.KEYS):
            record.msg, record.args = "[redacted log message]", ()
        return True


def create_app() -> FastAPI:
    settings = get_settings()
    settings.validate_for_production()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    for h in logging.getLogger().handlers:
        h.addFilter(_RedactingFilter())

    app = FastAPI(
        title="DeniTrack API",
        version="1.0.0",
        description="Debt and repayment ledger for small businesses. Money values are decimal strings in KES.",
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
    )
    install_error_handlers(app)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["*"],
            allow_headers=["*"],
            allow_credentials=False,
        )

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    api = APIRouter(prefix="/api/v1")
    for r in (auth, business, customers, debts, payments, reminders, reports, sync, integrations):
        api.include_router(r.router)

    @api.get("/health", tags=["health"])
    def health():
        db_ok = True
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception:  # pragma: no cover
            db_ok = False
        return {
            "status": "ok" if db_ok else "degraded",
            "database": db_ok,
            "integrations": {
                "mpesa": get_mpesa().mode,
                "sms": settings.sms_mode,
                "push": settings.push_mode,
            },
        }

    app.include_router(api)
    return app


app = create_app()
