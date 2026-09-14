"""SQLAlchemy declarative base shared by all models."""

from __future__ import annotations

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

# Unified naming convention so Alembic-generated constraint/index names are
# deterministic across databases (important for reversible migrations).
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Declarative base for all GSPlatform ORM models."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
