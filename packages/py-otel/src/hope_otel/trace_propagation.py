"""W3C trace-context propagation across async boundaries (TASK-636 OBS-16).

WHY THIS EXISTS
Two services cross non-HTTP boundaries the OTel auto-instrumentation cannot
see:

* STT — the API Gateway XADDs audio/control onto ``stt:audio|control:{sid}``
  and the STT service consumes them off a Redis Stream, then XADDs results
  back onto ``stt:result:{sid}``; ``FastAPIInstrumentor`` continues the trace
  for ``POST /internal/streaming/sessions``, but that context dies when the
  HTTP response is written.
* SMR — ``POST /api/v1/generate`` creates a task whose generation runs
  asynchronously and appends chunks to ``smr:stream:{task_id}``, while
  ``GET /api/v1/tasks/{id}/stream`` is a SEPARATE request that XREADs those
  chunks and relays them over SSE; ``FastAPIInstrumentor`` continues each
  request independently, so nothing joins the SSE stream to the generation
  that produced it.

Without this seam, everything a session then does (minutes of audio, every
utterance; every generated chunk) is an orphan trace. This module carries the
W3C trace context across those Redis-Stream hops.

WHY IT IS A SHARED PACKAGE, NOT A PER-SERVICE COPY
STT and SMR originally carried byte-for-byte duplicate copies of this module
(``apps/stt/src/stt/core/trace_propagation.py`` and
``apps/smr/src/smr/core/trace_propagation.py``) — a deliberate, time-boxed
tradeoff made while four agents were instrumenting different services
concurrently, to avoid a shared-package edit contending on the single root
``uv.lock``. That constraint is gone, so the module lives here once. Both
services depend on ``hope-otel`` as a uv workspace member (see their
``pyproject.toml``), the same pattern as ``hope-env``/``hope-runtime-models``.

This package is deliberately named for OTel/tracing, not folded into
``hope-env`` — that package's contract (env-file resolution, secrets-dir
precedence) is a distinct concern, and its own design principle is a single,
narrowly-scoped dependency; tracing does not belong under `hope_env`.

The TypeScript twin is
``packages/applications/src/services/baseServices/observability/trace-propagation.ts``.
Both are thin wrappers over the standard W3C propagator; neither parses a
traceparent by hand. Golden-traceparent tests (here, in each service's
integration tests, and in the TypeScript suite) pin the wire format so a
change here can never silently diverge from the other two.

DESIGN CONSTRAINTS

* **Context, never payload.** Only ``traceparent`` / ``tracestate`` cross this
  seam. Audio bytes, transcript text, and generated text are PHI or
  PHI-adjacent clinical content and are never handed to a propagator, nor
  stamped onto a span.
* **Free when tracing is off (TASK-411).** With no tracer provider configured
  the current span is ``INVALID_SPAN``; the W3C propagator then writes nothing
  and :func:`inject_trace_carrier` returns ``{}``. Callers add no stream fields
  and pay one function call.
* **Never a new failure mode.** Nothing here raises. A missing, malformed or
  truncated carrier yields ``None`` and the caller simply starts a fresh trace —
  the behaviour that existed before this module. A broken trace is an
  observability defect; a broken audio/generation stream is a clinical one.
"""

from __future__ import annotations

from typing import Any

from opentelemetry import propagate, trace
from opentelemetry.context import Context

#: W3C Trace Context header names — the only keys this seam ever moves.
TRACEPARENT_HEADER = "traceparent"
TRACESTATE_HEADER = "tracestate"

#: Allow-list of carrier keys. An explicit list (rather than "whatever the
#: propagator wrote") so a future propagator carrying extra baggage can never
#: smuggle a payload field onto a PHI-bearing Redis stream.
_CARRIER_KEYS: tuple[str, ...] = (TRACEPARENT_HEADER, TRACESTATE_HEADER)


def inject_trace_carrier(context: Context | None = None) -> dict[str, str]:
    """Serialise ``context`` (default: the current one) into a flat carrier.

    Returns ``{}`` when tracing is disabled or no valid span is current, so the
    caller can splat it into an ``XADD`` field dict unconditionally.
    """
    carrier: dict[str, str] = {}
    try:
        propagate.inject(carrier, context=context)
    except Exception:  # pragma: no cover - a propagator must never break I/O
        return {}
    return {k: v for k, v in carrier.items() if k in _CARRIER_KEYS and isinstance(v, str) and v}


def extract_trace_context(carrier: Any) -> Context | None:
    """Deserialise a carrier back into a context whose span is the REMOTE parent.

    Returns ``None`` when the carrier holds no usable parent — deliberately not
    the current context, so callers can distinguish "continue this trace" from
    "there was nothing to continue".
    """
    if not isinstance(carrier, dict):
        return None
    traceparent = carrier.get(TRACEPARENT_HEADER)
    if not isinstance(traceparent, str) or not traceparent:
        return None
    try:
        clean = {k: v for k, v in carrier.items() if k in _CARRIER_KEYS and isinstance(v, str)}
        ctx = propagate.extract(clean)
    except Exception:  # pragma: no cover - defensive
        return None
    return ctx if has_trace_context(ctx) else None


def has_trace_context(context: Context | None = None) -> bool:
    """True when ``context`` carries a span context valid enough to parent from."""
    try:
        span_context = trace.get_current_span(context).get_span_context()
    except Exception:  # pragma: no cover - defensive
        return False
    return bool(span_context.is_valid)


def carrier_from_redis_fields(fields: Any) -> dict[str, str]:
    """Lift ONLY the trace headers out of a Redis Stream entry's field mapping.

    ``redis.asyncio`` returns ``bytes`` keys and values; a stream entry also
    carries raw audio (``data``) and transcript text (``text``). Building the
    carrier here — rather than decoding the whole entry and handing it to a
    propagator — is what keeps PHI away from the telemetry path, and avoids
    UTF-8-decoding binary audio.
    """
    if not isinstance(fields, dict):
        return {}
    carrier: dict[str, str] = {}
    for key in _CARRIER_KEYS:
        value = fields.get(key)
        if value is None:
            value = fields.get(key.encode())
        if value is None:
            continue
        if isinstance(value, bytes):
            try:
                value = value.decode()
            except UnicodeDecodeError:
                continue
        if isinstance(value, str) and value:
            carrier[key] = value
    return carrier
