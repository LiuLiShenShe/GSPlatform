"""Pytest bootstrap — enable the development identity bypass for API tests.

Must be imported BEFORE ``app.main`` so the cached ``settings`` singleton picks
up the dev-identity flag. Phase 08 replaces this with real session auth; the
flag is refused by production startup checks.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("GS_ENV", "development")
os.environ.setdefault("GS_DEV_IDENTITY_ENABLED", "true")


def pytest_configure(config):  # noqa: D103
    """Prune leftover test upload sessions so the concurrency limit never trips."""
    # Import after env is set so Settings picks up dev-identity.
    from app.core.config import settings  # noqa: F811

    if settings.env != "development":
        return
    from app.core.identity import _resolve_dev_user_id
    from app.db.models.upload_session import UploadSession
    from app.db.session import SessionLocal

    try:
        session = SessionLocal()
        user_id = _resolve_dev_user_id(settings)
        stale = (
            session.query(UploadSession)
            .filter(UploadSession.owner_id == user_id)
            .delete(synchronize_session=False)
        )
        session.commit()
        if stale:
            os.environ["_GS_TEST_UPLOAD_CLEANED"] = str(stale)
    except Exception:  # noqa: S110
        pass


@pytest.fixture(autouse=True)
def _cleanup_dev_upload_sessions_after_each_test():  # noqa: ANN202
    """Ensure each test starts with a clean slate for the dev user's sessions.

    Upload tests create sessions (CREATED/UPLOADING...) that persist in the
    dev DB; without cleanup, successive tests trip the per-user concurrency
    limit of 5. Runs before and after every test.
    """
    from app.core.config import settings
    from app.core.identity import _resolve_dev_user_id
    from app.db.models.upload_session import UploadSession
    from app.db.session import SessionLocal

    yield
    if settings.env == "development":
        try:
            session = SessionLocal()
            user_id = _resolve_dev_user_id(settings)
            session.query(UploadSession).filter(
                UploadSession.owner_id == user_id
            ).delete(synchronize_session=False)
            session.commit()
        except Exception:  # noqa: S110
            pass


# ---------------------------------------------------------------------------
# Phase 08 scene fixtures (dev-identity acting user)
# ---------------------------------------------------------------------------

@pytest.fixture()
def db():
    """Request-scoped DB session (committed writes stay)."""
    from app.db.session import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def dev_user_id():
    """The deterministic dev user used by the identity bypass."""
    from app.core.config import settings
    from app.core.identity import _resolve_dev_user_id

    return _resolve_dev_user_id(settings)


@pytest.fixture()
def public_scene(db, dev_user_id):
    """A public + published scene owned by the dev user."""
    from tests.conftest_scenes import create_scene

    return create_scene(session=db, owner_id=dev_user_id)


@pytest.fixture()
def private_scene(db, dev_user_id):
    """A private + published scene owned by the dev user."""
    from tests.conftest_scenes import create_scene

    return create_scene(
        session=db,
        owner_id=dev_user_id,
        visibility="PRIVATE",
        status="PUBLISHED",
    )


@pytest.fixture()
def draft_scene(db, dev_user_id):
    """A draft scene owned by the dev user (not shareable)."""
    from tests.conftest_scenes import create_scene

    return create_scene(
        session=db,
        owner_id=dev_user_id,
        status="DRAFT",
        visibility="PRIVATE",
    )

