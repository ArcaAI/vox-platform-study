"""Retry logic with exponential backoff for provider errors.

Policy (TASK-818 §4.4, Lane C C-6): **at most 3 retries, exponential backoff,
always jittered — including when the upstream handed us an exact wait — and
`Retry-After` is authoritative when the upstream sent one.**

The "always jitter, even with an exact wait" clause is the non-obvious half. An
exact `Retry-After` is precisely the case where every rate-limited caller has
been given the SAME deadline by the SAME upstream, so obeying it to the
millisecond synchronises the herd instead of spreading it.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

#: Hard ceiling on retries, whatever a caller's ``RetryConfig`` asks for. A
#: request body is not allowed to raise the platform's amplification factor
#: against a struggling provider.
MAX_RETRIES = 3

#: Jitter as a fraction of the delay. Kept at the long-standing 10% rather than
#: widened to full jitter: the existing value is already load-bearing (see
#: `test_service_edge_cases.py`) and nothing measured justifies changing it.
_JITTER_FRACTION = 0.1


def calculate_backoff(
    attempt: int,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    *,
    retry_after: float | None = None,
) -> float:
    """Seconds to wait before the next attempt.

    ``retry_after`` — the wait an upstream explicitly asked for — wins over the
    computed exponential delay, but is still capped by ``max_delay`` (an upstream
    is allowed to ask for an hour; we are not obliged to hold a request that
    long) and still jittered, per the module docstring.
    """
    if retry_after is not None and retry_after > 0:
        delay = min(retry_after, max_delay)
    else:
        delay = min(base_delay * (2**attempt), max_delay)
    jitter = random.uniform(0.0, delay * _JITTER_FRACTION)
    return min(delay + jitter, max_delay)


def retry_after_from(exc: BaseException) -> float | None:
    """The wait, in seconds, that ``exc`` reports its upstream asked for.

    Two shapes, because two kinds of error reach the retry loop:

    * our own typed errors, which carry a ``retry_after`` attribute already; and
    * a provider SDK's HTTP error, which carries the raw response — where
      ``Retry-After`` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
      Both forms are accepted; anything else yields ``None``.

    ``None`` means "no opinion", never "zero" — a malformed header must fall back
    to the computed exponential backoff rather than retrying immediately.
    """
    direct = getattr(exc, "retry_after", None)
    if isinstance(direct, int | float) and direct > 0:
        return float(direct)

    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        raw = headers.get("retry-after") or headers.get("Retry-After")
    except (AttributeError, TypeError):
        return None
    if not raw:
        return None

    raw = str(raw).strip()
    try:
        seconds = float(raw)
    except ValueError:
        try:
            when = parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        seconds = (when - datetime.now(UTC)).total_seconds()
    return seconds if seconds > 0 else None


def should_retry(
    error_type: str,
    retry_on: list[str],
    attempt: int = 0,
    max_retries: int = 3,
) -> bool:
    """Determine if the request should be retried.

    ``attempt`` is 0-based, so ``MAX_RETRIES = 3`` permits attempts 0, 1 and 2 to
    answer ``True`` — three retries on top of the original call. A caller asking
    for more is silently held to the ceiling rather than refused: the request is
    still serviceable, it just does not get to choose the platform's retry
    budget.
    """
    if attempt >= min(max_retries, MAX_RETRIES):
        return False
    return error_type in retry_on
