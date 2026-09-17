"""CSRF protection — double-submit cookie pattern.

Flow:
1. On login, server generates a random CSRF token, hashes it, stores the hash
   in the session row, and sets the raw value in a *non-HttpOnly* cookie.
2. Client reads the `gs_csrf_token` cookie and sends it as the
   `X-CSRF-Token` header on every mutating request.
3. Server verifies: ``sha256(header_value) == session.csrf_token_hash``.

Why this is safe against CSRF:
- An attacker on a different origin cannot read the CSRF cookie (SameSite).
- An attacker on a different origin cannot set the X-CSRF-Token header
  (custom headers are not sent cross-origin).
- An attacker on the same origin is not CSRF — they already have full access.

The CSRF cookie is ``Secure`` in production, ``HttpOnly=False`` so JS can read
it, and ``SameSite=Strict``.
"""

from __future__ import annotations

from fastapi import Request

from app.core.errors import ForbiddenError
from app.core.security import sha256_hex

CSRF_COOKIE_NAME = "gs_csrf_token"
CSRF_HEADER_NAME = "x-csrf-token"


def verify_csrf(request: Request, csrf_token_hash: str) -> None:
    """Verify the double-submit CSRF token.

    Raises ``ForbiddenError`` if the header is missing or doesn't match the
    session-stored hash.
    """
    header_value = request.headers.get(CSRF_HEADER_NAME, "")
    if not header_value:
        raise ForbiddenError("缺少 CSRF 令牌")

    if sha256_hex(header_value) != csrf_token_hash:
        raise ForbiddenError("CSRF 令牌无效")
