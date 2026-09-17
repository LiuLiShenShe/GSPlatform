"""SQLAlchemy engine, session factory and the request-scoped session dependency.

Engine and pool settings come from ``app.core.config``; each request receives
its own session that commits on success, rolls back on exception and always
closes. The engine is created once at import time (no lazy pattern needed for
Phase 05; the readiness probe exercises the real connection).
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_settings = get_settings()

engine = create_engine(
    _settings.database_url,
    pool_size=_settings.database_pool_size,
    max_overflow=_settings.database_max_overflow,
    pool_timeout=_settings.database_pool_timeout,
    pool_recycle=_settings.database_pool_recycle,
    connect_args={"application_name": _settings.database_application_name},
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    class_=Session,
    autoflush=False,
    expire_on_commit=False,
)


def get_db_session() -> Iterator[Session]:
    """Request-scoped session: commit on success, rollback on error, always close."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def ping_database() -> bool:
    """Run a trivial round-trip against PostgreSQL. False if unreachable."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
