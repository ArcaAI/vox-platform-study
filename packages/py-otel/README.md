# `hope-otel` — shared OpenTelemetry helpers

W3C trace-context propagation across the Redis-Stream boundaries FastAPI's own
auto-instrumentation cannot see, for the HOPE Python services (TASK-636
OBS-16).

## Why it exists

STT and SMR each cross a non-HTTP boundary — a Redis Stream — that
`FastAPIInstrumentor` cannot trace through: STT's audio/control/result frames,
and SMR's generation chunks relayed over a separate SSE request. Both services
originally carried a byte-for-byte duplicate copy of this module
(`apps/stt/src/stt/core/trace_propagation.py`,
`apps/smr/src/smr/core/trace_propagation.py`) — a deliberate, time-boxed
tradeoff to avoid a shared-package edit contending on the single root
`uv.lock` while four agents instrumented different services concurrently.
That constraint is gone, so the module lives here once.

This is a separate package from `hope-env` rather than folded into it:
`hope-env`'s contract (env-file resolution, secrets-dir precedence) is a
distinct concern from tracing, and its own design principle is a single,
narrowly-scoped dependency.

## Usage

```python
from hope_otel import (
    TRACEPARENT_HEADER,
    TRACESTATE_HEADER,
    carrier_from_redis_fields,
    extract_trace_context,
    has_trace_context,
    inject_trace_carrier,
)

# Producer side — before an XADD:
fields = {"data": payload, **inject_trace_carrier()}

# Consumer side — after an XREAD:
carrier = carrier_from_redis_fields(entry_fields)
ctx = extract_trace_context(carrier)
```

See `src/hope_otel/trace_propagation.py` for the full contract (PHI-safety
constraints, no-op-when-tracing-off posture, never raises).

The TypeScript twin is
`packages/applications/src/services/baseServices/observability/trace-propagation.ts`.
All three implementations are pinned to the same golden W3C traceparent
literal by their respective test suites — a wire-format disagreement between
any two would silently sever cross-service traces.

## Install

A `uv` workspace member (root `pyproject.toml`) and an editable install in the
shared conda env `arcaenv` (`scripts/setup-python-env.sh`). Consumers declare
it as `hope-otel = { workspace = true }`.

## Tests

```bash
pnpm py-otel:test      # pytest packages/py-otel/tests
```
