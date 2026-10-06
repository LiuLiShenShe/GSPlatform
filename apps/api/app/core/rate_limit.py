"""Rate limiting — sliding-window counters.

Memory-backed sliding window (single process) plus a Redis-backed shared
counter for production (FIX-06 §15).

Selection: endpoints call :func:`check_rate_limit_shared`, which uses the
Redis backend when ``settings.rate_limit_backend == "redis"`` (counters shared
across uvicorn workers) and degrades to the in-memory limiter on any Redis
outage — never failing open.  Dev/test default to ``memory`` so tests keep the
fast, dependency-free sliding window.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from redis import Redis as _RedisClient

logger = logging.getLogger("gsplatform.rate_limit")

# ---------------------------------------------------------------------------
# Memory-backed sliding window
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_windows: dict[tuple[str, str], list[float]] = defaultdict(list)

_redis_client: _RedisClient | None = None
_redis_client_attempted = False


@dataclass
class RateLimitResult:
    """Outcome of a rate-limit check."""

    allowed: bool
    limit: int
    current: int
    retry_after_seconds: int = 0
    reason: str = ""


def _prune(key: tuple[str, str], window_seconds: float) -> None:
    cutoff = time.monotonic() - window_seconds
    bucket = _windows[key]
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)


def check_rate_limit(
    scope: str,
    key: str,
    *,
    limit: int,
    window_seconds: int = 60,
) -> RateLimitResult:
    """Check *key* against *limit* requests per *window_seconds*.

    Returns an ``allowed`` decision; callers must reject when ``allowed`` is
    False and surface ``retry_after_seconds``.
    """
    now = time.monotonic()
    composite = (scope, key)
    with _lock:
        _prune(composite, float(window_seconds))
        bucket = _windows[composite]
        # Evict this key's window wholesale once it exceeds a sane size so a
        # sustained flood can't grow memory without bound.
        if len(bucket) > limit * 4 + 64:
            _windows[composite] = bucket[-limit:]

        if len(bucket) >= limit:
            earliest = bucket[0]
            retry_after = max(1, int(window_seconds - (now - earliest)))
            return RateLimitResult(
                allowed=False,
                limit=limit,
                current=len(bucket),
                retry_after_seconds=retry_after,
                reason=f"{scope} 请求过于频繁，请稍后重试",
            )

        bucket.append(now)
        return RateLimitResult(allowed=True, limit=limit, current=len(bucket))


def reset_rate_limits(scope: str, key: str) -> None:
    """Drop counters for a scope+key (used by tests)."""
    with _lock:
        _windows.pop((scope, key), None)


# ---------------------------------------------------------------------------
# Redis-backed shared counters (production)
# ---------------------------------------------------------------------------

def _get_redis() -> _RedisClient | None:
    """Lazy shared Redis client for the rate-limiter keyspace.

    Cache the client once; connectivity is only established on the first
    command, so availability errors surface inside :func:`check_rate_limit_redis`
    and trigger the memory fallback.
    """
    global _redis_client, _redis_client_attempted
    if not _redis_client_attempted:
        _redis_client_attempted = True
        try:
            from redis import from_url

            from app.core.config import get_settings

            _redis_client = from_url(  # type: ignore[no-untyped-call]
                get_settings().redis_url,
                socket_connect_timeout=1.0,
                socket_timeout=1.0,
                decode_responses=True,
            )
        except Exception:
            logger.warning("Rate-limiter Redis client init failed", exc_info=True)
            _redis_client = None
    return _redis_client


def check_rate_limit_redis(
    scope: str,
    key: str,
    *,
    limit: int,
    window_seconds: int = 60,
) -> RateLimitResult:
    """Redis fixed-window counter shared across uvicorn workers.

    Key ``gspl:rl:{scope}:{key}`` counts increments; the TTL is installed on
    the first increment so the window expires on its own.  Raises (caller
    falls back to memory) when Redis is unreachable.
    """
    client: Any = _get_redis()
    if client is None:
        raise RuntimeError("Rate-limiter Redis client unavailable")
    rk = f"gspl:rl:{scope}:{key}"
    pipe = client.pipeline()
    pipe.incr(rk)
    pipe.expire(rk, window_seconds, nx=True)
    current, _ = pipe.execute()
    current = int(current)
    if current > limit:
        ttl = client.ttl(rk)
        return RateLimitResult(
            allowed=False,
            limit=limit,
            current=current,
            retry_after_seconds=max(1, int(ttl)),
            reason=f"{scope} 请求过于频繁，请稍后重试",
        )
    return RateLimitResult(allowed=True, limit=limit, current=current)


def reset_rate_limits_redis(scope: str, key: str) -> None:
    """Drop a Redis counter (used by tests)."""
    client = _get_redis()
    if client is not None:
        try:
            client.delete(f"gspl:rl:{scope}:{key}")
        except Exception:
            logger.debug("Redis rate-limit reset failed (scope=%s)", scope, exc_info=True)


def check_rate_limit_shared(
    scope: str,
    key: str,
    *,
    limit: int,
    window_seconds: int = 60,
) -> RateLimitResult:
    """The limiter call sites use (auth/assistant/shares).

    Redis backend when configured; any outage degrades to the memory sliding
    window rather than failing open entirely (FIX-06 §15).
    """
    from app.core.config import get_settings

    if get_settings().rate_limit_backend == "redis":
        try:
            return check_rate_limit_redis(
                scope, key, limit=limit, window_seconds=window_seconds
            )
        except Exception:
            logger.warning(
                "Redis rate limiter unavailable; falling back to memory "
                "(scope=%s)",
                scope,
                exc_info=True,
            )
            return check_rate_limit(
                scope, key, limit=limit, window_seconds=window_seconds
            )
    return check_rate_limit(scope, key, limit=limit, window_seconds=window_seconds)
