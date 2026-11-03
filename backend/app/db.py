from collections.abc import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str) -> Engine:
    kwargs: dict = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
        if url in ("sqlite://", "sqlite:///:memory:"):
            from sqlalchemy.pool import StaticPool

            kwargs["poolclass"] = StaticPool  # one shared in-memory DB (tests)
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

    return engine


engine = make_engine(get_settings().database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@event.listens_for(Session, "after_begin")
def _apply_tenant_scope(session: Session, _transaction, connection) -> None:
    """Re-apply PostgreSQL RLS scope at the start of every transaction in this session."""
    if connection.dialect.name != "postgresql":
        return
    if session.info.get("bypass_rls"):
        connection.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
    elif "business_id" in session.info:
        connection.execute(
            text("SELECT set_config('app.business_id', :bid, true)"),
            {"bid": str(session.info["business_id"])},
        )


def set_tenant(db: Session, business_id) -> None:
    """Scope row-level security to one business for the rest of this session."""
    db.info["business_id"] = business_id
    if db.in_transaction():
        _apply_tenant_scope(db, None, db.connection())


def bypass_tenant(db: Session) -> None:
    """For trusted system jobs (scheduler, provider callbacks) that span tenants."""
    db.info["bypass_rls"] = True
    if db.in_transaction():
        _apply_tenant_scope(db, None, db.connection())
