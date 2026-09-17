"""Rate limiting — sliding-window counters.

In-memory implementation keyed by scope + client key (e.g. ``login`` +
``client_ip``).  Suitable for single-process development; production should
run multiple workers behind Nginx and either pin each client IP to a worker
or swap this module for a Redis-backed limiter (same interface).
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Memory-backed sliding window
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_windows: dict[tuple[str, str], list[float]] = defaultdict(list)


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
