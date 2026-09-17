"""Security primitives — password hashing, token generation, CSRF.

All crypto operations are centralized here.  Password hashing uses argon2id
(the winner of the Password Hashing Competition).  Session and CSRF tokens
are random, high-entropy values stored only as SHA-256 hashes in the database.
"""

from __future__ import annotations

import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_ph = PasswordHasher(
    time_cost=2,
    memory_cost=19456,  # 19 MiB
    parallelism=1,
    hash_len=32,
    salt_len=16,
)


# ---------------------------------------------------------------------------
# Password hashing (argon2id)
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    """Hash a plaintext password with argon2id."""
    return _ph.hash(password)


def verify_password(hash: str, password: str) -> bool:
    """Verify *password* against *hash*.  Returns False on any error."""
    try:
        return _ph.verify(hash, password)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Opaque tokens (session key, CSRF value, share token)
# ---------------------------------------------------------------------------

def generate_session_token() -> str:
    """Generate a 32-byte URL-safe random token (the raw session key)."""
    return secrets.token_urlsafe(32)


def generate_csrf_token() -> str:
    """Generate a 24-byte URL-safe random CSRF value."""
    return secrets.token_urlsafe(24)


def generate_share_token() -> str:
    """Generate a 24-byte URL-safe random share token."""
    return secrets.token_urlsafe(24)


def sha256_hex(value: str) -> str:
    """Return the hex-encoded SHA-256 digest of *value*."""
    return hashlib.sha256(value.encode()).hexdigest()
