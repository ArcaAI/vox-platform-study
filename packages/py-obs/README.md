# hope-obs — shared logging & tracing runtime

One structured-logging chain and one OpenTelemetry tracing setup for all six HOPE Python services
and their workers, implementing §3 (R-1 … R-8) of
[`TASK-987`](../../docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md).

## Layout

| Path | What it holds |
|---|---|
| `src/hope_obs/__init__.py` | The public surface — the only module a service imports |
| `src/hope_obs/config.py` | `ObservabilityConfig` + `from_env`: the one env contract (R-2) |
| `src/hope_obs/logging.py` | `configure_logging` / `get_logger` / `bind_request_context` — structlog + stdlib bridge, JSON on stdout (R-3) |
| `src/hope_obs/tracing.py` | `build_tracer_provider` / `instrument_fastapi` / `shutdown_tracer_provider` / `get_tracer`, sampler and resource (R-7, R-8) |
| `src/hope_obs/middleware.py` | `RequestContextMiddleware`, `AccessLogMiddleware` — pure ASGI, never `BaseHTTPMiddleware` (R-4) |
| `src/hope_obs/phi.py` | `phi_sanitization_hook`, `redact_id` — the PHI-safety helpers (R-3, R-7) |
| `src/hope_obs/runtime.py` | `configure_observability` / `shutdown_observability` / `configure_worker_observability` (R-2, R-6) |
| `tests/` | pytest, hermetic — no network, no live collector, no env file |

## Commands

```bash
pnpm py-obs:test            # conda run -n arcaenv pytest packages/py-obs/tests
pnpm py-obs:lint            # ruff check
pnpm py-obs:typecheck       # mypy --strict
pnpm py-obs:format:check    # black --check
```

## How it works

### Why it exists

TASK-987 reviewed the fleet and found six logging stacks, six enable contracts and four services
emitting no traces at all in the only live environment. The five findings this package answers
directly:

| Finding | What was wrong | What `hope_obs` does |
|---|---|---|
| **F-01** | Four of six services defaulted their own `*_OTEL_ENABLED` to `False`, so shipped instrumentation was dead code in `hope-v2-dev` | There is no boolean. `OTEL_EXPORTER_OTLP_ENDPOINT`'s **presence** is the enable signal |
| **F-02** | NLP had `OTEL_EXPORTER_OTLP_ENDPOINT` + two `OTEL_*_ENABLED=true` set correctly and exported nothing, because a *sixth* variable (`NLP_OTEL_ENABLED`) was the one the code read | One signal cannot disagree with itself |
| **F-03** | NLP defined a JSON formatter and never installed it — plain text in Loki, dead trace-correlation code | One `configure_logging`, one chain, one renderer |
| **F-04** | The STT Dramatiq worker installed a logger provider and no tracer: non-recording spans, log lines with no `traceId` | `configure_worker_observability` installs a **real** `TracerProvider` |
| **F-05** | Only one of six services routed stdlib logging through structlog, so `httpx` / `uvicorn.error` / `transformers` records landed unparsed beside the JSON | `ProcessorFormatter` + `foreign_pre_chain`, pinned by a test |

### The env contract (R-2)

| Variable | Meaning | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector address. **Presence is the enable signal.** | unset → tracing off |
| `OTEL_SERVICE_NAME` | Overrides the `service_name` argument | the argument |
| `DEPLOYMENT_ENVIRONMENT` → `NODE_ENV` | Resource environment; **both** spellings emitted (`deployment.environment` and `.name`) | `development` |
| `OTEL_TRACES_SAMPLER_ARG` | Head-sampling ratio for `ParentBased(TraceIdRatioBased(…))` | `1.0` |
| `LOG_LEVEL`, overridden by `<SVC>_LOG_LEVEL` | Log level — a name (`INFO`) or a number (`20`) | `info` |

`insecure` is derived from the endpoint scheme, never from a flag. The environment default is
`development`, never `production`: a mislabelled dev span is noise, a mislabelled prod span corrupts
an audit trail.

A service whose log level lives under a different prefix narrows one field instead of
reimplementing the rest:

```python
config = replace(ObservabilityConfig.from_env("guardrail"), log_level=settings.log_level)
```

### Usage — a FastAPI service

```python
from hope_obs import ObservabilityConfig, configure_observability, shutdown_observability

config = ObservabilityConfig.from_env("stt", service_version=build_info.version)

def create_app() -> FastAPI:
    app = FastAPI(lifespan=lifespan)
    configure_observability(app, config)   # logging + request context + access log + tracing
    return app

# lifespan teardown:
shutdown_observability(app)
```

`configure_observability` installs `RequestContextMiddleware` (outermost) and `AccessLogMiddleware`
for you. A service that must control its own middleware ordering can import them from
`hope_obs.middleware` and add them itself.

### Usage — a worker (no FastAPI in the process)

```python
from hope_obs import ObservabilityConfig, configure_worker_observability

handle = configure_worker_observability(ObservabilityConfig.from_env("stt"))
...
handle.shutdown()      # on SIGTERM — flushes buffered spans
```

The service name gets a `-worker` suffix unless the operator already supplied one, so an
operator-set `OTEL_SERVICE_NAME=hope-stt-v2-worker` is not mangled into `…-worker-worker`.

FastAPI and Starlette are **typing-only** imports, and the OTel FastAPI/httpx instrumentations are
imported lazily inside the functions that need them, so `import hope_obs` works in a worker image
that ships no web framework. A test asserts it in a subprocess that blocks both modules.

### Writing a log line

```python
from hope_obs import get_logger, redact_id

logger = get_logger(__name__)
logger.info("stt.session.started", session=redact_id(session_id), ms=12)
```

`<service>.<area>.<event>`, snake_case, a stable literal — every variable is a field, never an
f-string. Every line carries `timestamp`, `level`, `logger`, `event`, `service`, plus `traceId`,
`spanId`, `request_id` and `tenant_id` when they exist.

**Never log clinical content** — no transcript, prompt, completion, summary, note or entity text, at
any level, including `DEBUG`. Identifiers go through `redact_id`, which is the only sanctioned way
an id reaches a log line. See [`telemetry-phi-guardrails.md`](../../docs/operations/telemetry-phi-guardrails.md).

### One log path (R-5)

Logs leave the process on **stdout only**. Alloy tails every pod in the namespace and writes to
Loki, so an OTLP log exporter is a second copy with a different shape (F-10). This package
deliberately ships **no** `LoggerProvider` and **no** `OTLPLogExporter`; traces (and any metrics a
service exports) continue over OTLP. Correlation survives because `traceId` is a field on the JSON
line and Grafana joins Loki → Tempo on it.

### Tracing never blocks a boot

`configure_observability` and `configure_worker_observability` never raise. An exporter that cannot
be constructed, an instrumentation that fails, a malformed endpoint — each degrades to no-tracing
with one warning line and `app.state.tracer_provider = None`.

An *unreachable* collector is a different case and is deliberately NOT treated as a failure: the
OTLP gRPC exporter connects lazily, so tracing stays on and spans buffer until the collector
returns. Detecting unreachability at configure time would mean probing the collector during boot,
which is exactly the dependency this posture exists to avoid.

### Install

A `uv` workspace member (root `pyproject.toml`) and an editable install in the shared conda env
`arcaenv` (`scripts/setup-python-env.sh`, which globs `packages/py-*` and needs no edit). Consumers
declare it as `hope-obs = { workspace = true }`. Registering the workspace member, regenerating
`uv.lock`, adding the root `package.json` scripts and the CI install lines are orchestrator-owned
steps (TASK-987 §4) — not something a service lane does.

Every dependency lower bound here is one all six services already declare, so adding this package
cannot perturb the single root `uv.lock`.

## Related

- [`TASK-987`](../../docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md) — the standard this implements, and the findings behind each rule
- [`telemetry-phi-guardrails.md`](../../docs/operations/telemetry-phi-guardrails.md) — the four-layer PHI policy; this package is its emitter-side half
- [`hope-otel`](../py-otel/README.md) — W3C trace-context propagation across the Redis-Stream boundaries `FastAPIInstrumentor` cannot see; complementary, not overlapping
- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — FastAPI/pydantic-settings/test conventions for the services that adopt this
