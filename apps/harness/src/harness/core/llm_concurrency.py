"""Shared per-endpoint LLM concurrency governor + rate-limit-aware retry.

The inferential pass fans groundedness + citation_verify +
safety out concurrently (``asyncio.gather``) and they all hit the **same**
self-hosted LM Studio box (``:1234``): the judge (``gemma-4-e4b``), the Granite
Guardian safety screen, and the dense embeddings client share one endpoint. A
small local server serves only a bounded number of concurrent requests; bursting
past that makes LM Studio terminate/unload the model engine mid-call (HTTP ``400
{'error':'terminated'}`` / 5xx), which used to degrade the *persisted*
``citation_verify``/``safety`` decisions even though the sensor logic is correct.

This module is the cross-cutting fix, imported by every harness LLM client:

* **One semaphore per provider endpoint** — keyed by ``scheme://host:port`` so a
  ``base_url`` with or without the ``/v1`` suffix maps to the same limiter. Every
  caller hitting the same box collectively respects one admin-set cap
  (``HARNESS_LLM_MAX_CONCURRENCY``); the gather still fans out, but in-flight
  requests are capped, so the provider never sees a burst.
* **Rate-limit-aware retry** (:func:`governed_request`) — exponential backoff with
  jitter; honors HTTP ``429`` ``Retry-After``; retries 5xx, connection errors and
  the LM Studio ``terminated`` 400; bounded attempts; re-raises the last error once
  exhausted so the caller's *existing* fail-safe degrade still owns the final
  outcome (a broken backend never masquerades as a passing gate).

Config is admin-settable via env (see ``apps/harness/.env.example``). Defaults are
deliberately conservative (cap ``1`` — the burst-resistant sequential behaviour LM
Studio tolerated in the earlier runs), tunable up for a provider that allows more
concurrency.
"""

from __future__ import annotations

import asyncio
import os
import random
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import TypeVar
from urllib.parse import urlsplit

from hope_env import load_env

T = TypeVar("T")


@dataclass(frozen=True)
class LlmGovernorConfig:
    """Admin-settable per-endpoint concurrency + retry knobs (env: ``HARNESS_LLM_*``)."""

    max_concurrency: int = 1
    max_attempts: int = 5
    backoff_base_s: float = 0.5
    backoff_max_s: float = 20.0
    jitter_s: float = 0.25
    # Per-call wall-clock timeout. Bounds EACH individual model call
    # so one hung LM Studio request can't burn the whole 900s activity budget before
    # Temporal retries. A timed-out call is classified transient (see :func:`is_retryable`)
    # and retried within ``max_attempts`` before the caller's fail-safe degrade takes over.
    # ``<= 0`` disables the bound. Mirrors ``Settings.llm_request_timeout_s``.
    request_timeout_s: float = 120.0


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def get_llm_governor_config() -> LlmGovernorConfig:
    """Build the governor config from env / ``.env.<env>`` (admin-settable; call per use)."""
    load_env()
    return LlmGovernorConfig(
        max_concurrency=max(1, _env_int("HARNESS_LLM_MAX_CONCURRENCY", 1)),
        max_attempts=max(1, _env_int("HARNESS_LLM_MAX_ATTEMPTS", 5)),
        backoff_base_s=max(0.0, _env_float("HARNESS_LLM_BACKOFF_BASE_S", 0.5)),
        backoff_max_s=max(0.0, _env_float("HARNESS_LLM_BACKOFF_MAX_S", 20.0)),
        jitter_s=max(0.0, _env_float("HARNESS_LLM_BACKOFF_JITTER_S", 0.25)),
        request_timeout_s=_env_float("HARNESS_LLM_REQUEST_TIMEOUT_S", 120.0),
    )


def endpoint_key(base_url: str) -> str:
    """Normalize a ``base_url`` to its provider identity (``scheme://host:port``).

    The judge (``…/v1``), the safety guardian (``…/v1``) and the embeddings client
    (``…/v1``) all point at the same LM Studio box; stripping the path (and any
    ``/v1`` suffix) collapses them onto one shared limiter key so the cap is honored
    across every client hitting that box.
    """
    raw = base_url or ""
    parts = urlsplit(raw if "//" in raw else f"//{raw}")
    scheme = parts.scheme or "http"
    host = (parts.hostname or "").lower()
    port = parts.port
    netloc = f"{host}:{port}" if port is not None else host
    return f"{scheme}://{netloc}"


# Registry: endpoint -> (owning event loop, semaphore). ``asyncio.Semaphore`` is
# loop-bound, so we recreate when the running loop changes (each pytest-asyncio test
# gets a fresh loop); the single long-lived worker loop reuses one limiter per
# endpoint for the life of the process.
_LIMITERS: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Semaphore]] = {}


def endpoint_semaphore(base_url: str, max_concurrency: int) -> asyncio.Semaphore:
    """Return the shared per-endpoint semaphore (created once per endpoint/loop).

    The cap is fixed at first creation for an endpoint within a loop, so all callers
    truly share one limiter regardless of who creates it first.
    """
    loop = asyncio.get_running_loop()
    key = endpoint_key(base_url)
    entry = _LIMITERS.get(key)
    if entry is None or entry[0] is not loop:
        sem = asyncio.Semaphore(max(1, max_concurrency))
        _LIMITERS[key] = (loop, sem)
        return sem
    return entry[1]


def reset_endpoint_limiters() -> None:
    """Drop all cached limiters (tests only — each test sizes its own cap)."""
    _LIMITERS.clear()


@asynccontextmanager
async def limit_endpoint(base_url: str, max_concurrency: int | None = None) -> AsyncIterator[None]:
    """Hold the shared per-endpoint slot for the duration of one call."""
    cap = (
        max_concurrency
        if max_concurrency is not None
        else get_llm_governor_config().max_concurrency
    )
    sem = endpoint_semaphore(base_url, cap)
    async with sem:
        yield


class LlmCallTimeout(TimeoutError):
    """A per-call wall-clock timeout raised by :func:`call_with_timeout`.

    Subclasses ``TimeoutError`` so :func:`is_retryable` still classifies it transient
    (idempotent governed calls keep retrying a hung call as before). The distinct type
    lets :func:`governed_request` recognise the per-call timeout specifically and, for a
    NON-idempotent caller (``retry_on_timeout=False`` — e.g. SMR generate), treat it as
    terminal: the request may have already reached the model, so re-issuing it would
    re-invoke a non-idempotent operation.
    """


async def call_with_timeout(operation: Callable[[], Awaitable[T]], timeout_s: float) -> T:
    """Run a single LLM call under a per-call wall-clock timeout.

    ``timeout_s <= 0`` disables the bound (legacy behaviour). On expiry ``asyncio.timeout``
    cancels the in-flight call and we re-raise a descriptive :class:`LlmCallTimeout` (a
    ``TimeoutError`` subclass) — which :func:`is_retryable` classifies transient, so the
    per-endpoint retry loops treat a hung call like any other transient backend failure
    (retry within budget, then the caller's existing fail-safe degrade owns the outcome —
    never a silent auto-PASS). A NON-idempotent caller passes ``retry_on_timeout=False`` to
    :func:`governed_request` so this timeout is NOT re-issued (see that function).
    """
    if not timeout_s or timeout_s <= 0:
        return await operation()
    try:
        async with asyncio.timeout(timeout_s):
            return await operation()
    except TimeoutError as exc:
        raise LlmCallTimeout(f"llm request exceeded {timeout_s:g}s per-call timeout") from exc


# --- retry classification ---------------------------------------------------

# Substrings marking a *transient* backend failure worth retrying (a model engine
# terminated/unloaded under load and will JIT-reload, a dropped connection, a
# momentary 5xx/overload, a rate limit) — as opposed to a deterministic 4xx (bad
# request shape, auth) that would only fail again.
_TRANSIENT_MARKERS = (
    "terminated",
    "connection",
    "connect",
    "reset",
    "timeout",
    "timed out",
    "overloaded",
    "unavailable",
    "temporarily",
    "rate limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
)


def _status_code(exc: Exception) -> int | None:
    """Best-effort HTTP status from an openai/httpx-style exception."""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    resp = getattr(exc, "response", None)
    code = getattr(resp, "status_code", None)
    return code if isinstance(code, int) else None


def _body_text(exc: Exception) -> str:
    """Best-effort response body (httpx errors hide the body from ``str(exc)``)."""
    resp = getattr(exc, "response", None)
    if resp is None:
        return ""
    try:
        return resp.text or ""
    except Exception:  # noqa: BLE001 — body unreadable (streamed/closed) -> ignore
        return ""


def _message(exc: Exception) -> str:
    return f"{exc} {_body_text(exc)}".lower()


def _retry_after_seconds(exc: Exception) -> float | None:
    """Parse a ``Retry-After`` header (delta-seconds or HTTP-date) if present."""
    resp = getattr(exc, "response", None)
    headers = getattr(resp, "headers", None)
    if not headers:
        return None
    try:
        value = headers.get("retry-after") or headers.get("Retry-After")
    except AttributeError:
        return None
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())


def is_retryable(exc: Exception) -> bool:
    """True for a transient failure (timeout / 429 / 5xx / connection / ``terminated`` 400)."""
    # A per-call wall-clock timeout (``asyncio.timeout`` raises a bare ``TimeoutError`` with
    # an empty message, so marker-matching alone would miss it) is a transient hang.
    if isinstance(exc, TimeoutError):
        return True
    status = _status_code(exc)
    if status is not None:
        if status == 429 or 500 <= status <= 599:
            return True
        if status == 400:
            return "terminated" in _message(exc)
        if 400 <= status <= 499:
            return False
    return any(marker in _message(exc) for marker in _TRANSIENT_MARKERS)


def _backoff_delay(attempt: int, cfg: LlmGovernorConfig) -> float:
    """Exponential backoff (capped) + uniform jitter, for retry ``attempt`` (0-based)."""
    base = min(cfg.backoff_max_s, cfg.backoff_base_s * (2**attempt))
    return float(base + random.uniform(0.0, cfg.jitter_s))


async def governed_request(
    base_url: str,
    operation: Callable[[], Awaitable[T]],
    *,
    config: LlmGovernorConfig | None = None,
    retry_on_timeout: bool = True,
) -> T:
    """Run ``operation`` under the shared per-endpoint cap with rate-limit-aware retry.

    Acquires the shared endpoint slot for each *attempt* only — the slot is released
    during backoff so a sleeping retry never starves other callers of the same box.
    Retries 429 (honoring ``Retry-After``), 5xx, connection errors and the LM Studio
    ``terminated`` 400; gives up after ``max_attempts`` and re-raises the last error,
    so the caller's existing degrade path owns the final (fail-safe) outcome.

    ``retry_on_timeout``: a NON-idempotent ``operation`` (e.g. SMR generate)
    passes ``False`` so a per-call :class:`LlmCallTimeout` is TERMINAL — the request may
    have already reached and run the model, and the per-call ``asyncio.timeout`` cannot
    tell pre-send from post-send, so re-issuing it risks a second (divergent) generation.
    Idempotent callers keep the default ``True`` and retry a hung call as before. NOTE:
    this only covers the per-call *timeout*; a 5xx or the LM-Studio ``terminated`` 400 that
    arrives AFTER the model ran is still retried (pre-existing, lower risk — a downstream
    idempotency key is the durable fix, tracked as apps/text coordination).
    """
    cfg = config or get_llm_governor_config()
    last_exc: Exception | None = None
    for attempt in range(cfg.max_attempts):
        retry_after: float | None = None
        async with limit_endpoint(base_url, cfg.max_concurrency):
            try:
                # Per-call timeout: a hung call surfaces as a transient
                # ``LlmCallTimeout``, retried within ``max_attempts`` like any 5xx —
                # UNLESS the caller is non-idempotent (``retry_on_timeout=False``).
                return await call_with_timeout(operation, cfg.request_timeout_s)
            except Exception as exc:  # noqa: BLE001 — classified + re-raised below
                last_exc = exc
                if attempt + 1 >= cfg.max_attempts or not is_retryable(exc):
                    raise
                # A per-call timeout of a non-idempotent op is terminal
                # (re-issuing may re-invoke the model). Raise instead of retrying.
                if isinstance(exc, LlmCallTimeout) and not retry_on_timeout:
                    raise
                retry_after = _retry_after_seconds(exc)
        delay = retry_after if retry_after is not None else _backoff_delay(attempt, cfg)
        await asyncio.sleep(delay)
    assert last_exc is not None  # pragma: no cover — loop returns or raises above
    raise last_exc
