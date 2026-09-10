"""Retry logic with exponential backoff for provider errors.

Policy (Lane C C-6): **at most 3 retries, exponential backoff,
always jittered — including when the upstream handed us an exact wait — and
`Retry-After` is authoritative when the upstream sent one.**

The "always jitter, even with an exact wait" clause is the non-obvious half. An
exact `Retry-After` is precisely the case where every rate-limited caller has
been given the SAME deadline by the SAME upstream, so obeying it to the
millisecond synchronises the herd instead of spreading it.

TASK-946 D5: a provider 4xx is a DETERMINISTIC rejection of this exact
request (a malformed body, an oversized prompt) — retrying it burns the
platform's retry budget against an outcome that cannot change, and the
generic 502 that used to follow reads as "the provider is down" rather than
"the request was rejected". `provider_status_code_from` / `provider_error_code_from`
below classify that shape; `should_retry` refuses it unconditionally.
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
      Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
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


#: The error-type value a deterministic provider 4xx is classified as (see
#: `provider_status_code_from` below). Structurally excluded from
#: `should_retry` — never retried, whatever a caller's ``retry_on`` asks for.
INVALID_REQUEST_ERROR_TYPE = "invalid_request"

#: The `code` this service answers with for a provider 4xx that is NOT
#: recognised as a context-window overflow. Same naming convention as
#: `services/output_gate.py`'s `REJECTED_CODE` / `UNAVAILABLE_CODE`.
PROVIDER_INVALID_REQUEST_CODE = "PROVIDER_INVALID_REQUEST"

#: The `code` for a provider 4xx whose message says the prompt (plus history/
#: system prompt) no longer fits the model's context window — the D5 trial
#: evidence (LM Studio: ``"Context size has been exceeded."``). Checked
#: case-insensitively as a substring, not an exact match: every engine phrases
#: this differently and none of them hand back a machine-readable field for
#: it, only prose.
CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED"

_CONTEXT_WINDOW_PHRASES: tuple[str, ...] = (
    "context size",
    "context length",
    "context window",
    "maximum context",
    "too many tokens",
    "exceeds the model",
)


def provider_status_code_from(exc: BaseException) -> int | None:
    """The HTTP status code a provider's own response carried, if any.

    Duck-typed across the two shapes Text's provider adapters actually raise
    (verified against the installed SDKs — see the D5 evidence in
    ``api/endpoints/generate.py``, not guessed):

    * ``openai.APIStatusError`` (LM Studio, vLLM, the generic OpenAI-compat
      adapter, Azure OpenAI) and ``anthropic.APIStatusError`` both expose
      ``.status_code`` directly; and
    * a raw ``httpx.HTTPStatusError`` (Ollama, llama.cpp, TEI —
      ``resp.raise_for_status()``) carries it on ``.response.status_code``
      instead.

    Neither shape is imported here, so a provider adapter added later needs no
    update to this function as long as it raises one of these two familiar
    shapes. A Bedrock ``botocore.exceptions.ClientError`` matches neither
    (its ``.response`` is a plain ``dict``, not an ``httpx.Response``) and
    correctly falls through to ``None`` — unclassified, exactly like before
    this function existed.
    """
    direct = getattr(exc, "status_code", None)
    if isinstance(direct, int):
        return direct
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def is_provider_invalid_request(exc: BaseException) -> bool:
    """Whether ``exc`` is a deterministic provider 4xx — never retryable."""
    status_code = provider_status_code_from(exc)
    return status_code is not None and 400 <= status_code < 500


def provider_error_code_from(exc: BaseException) -> str:
    """The response ``code`` for a provider 4xx already confirmed via
    :func:`is_provider_invalid_request`.

    ``str(exc)`` is used rather than a specific SDK's ``.message`` attribute so
    an unrecognised exception type still classifies correctly instead of
    raising — the same "duck-type, don't import every SDK" posture as
    :func:`provider_status_code_from`.
    """
    text = str(exc).lower()
    if any(phrase in text for phrase in _CONTEXT_WINDOW_PHRASES):
        return CONTEXT_WINDOW_EXCEEDED_CODE
    return PROVIDER_INVALID_REQUEST_CODE


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

    A deterministic provider 4xx (``INVALID_REQUEST_ERROR_TYPE``) is refused
    UNCONDITIONALLY — before the attempt-ceiling check and regardless of
    ``retry_on`` — because no number of retries changes an outcome the
    provider has already decided synchronously. This is structural, not a
    ``retry_on`` default: a caller that explicitly lists ``"invalid_request"``
    still gets exactly one attempt.
    """
    if error_type == INVALID_REQUEST_ERROR_TYPE:
        return False
    if attempt >= min(max_retries, MAX_RETRIES):
        return False
    return error_type in retry_on
