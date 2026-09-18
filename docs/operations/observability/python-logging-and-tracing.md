# Python Logging & Tracing — the standard

> How every Python service in this repo emits logs and traces, why it is one shared package
> rather than six implementations, and what a new service or a new emitter has to do.
>
> Established by TASK-987 (2026-09-18). PHI rules live in
> [`../telemetry-phi-guardrails.md`](../telemetry-phi-guardrails.md) and are unchanged by this page.

## The one-line version

Every Python service configures logging and tracing through **`packages/py-obs` (`hope_obs`)** and
nothing else. A service that reaches for `structlog.configure`, builds its own `TracerProvider`, or
writes its own request-id middleware is drifting, and
`tests/contracts/test_observability_parity.py` fails on it.

## Layout

| Path | What it holds |
|---|---|
| `packages/py-obs/src/hope_obs/` | the implementation — config, logging, tracing, middleware, PHI, runtime |
| `tests/contracts/test_observability_parity.py` | the gate that keeps all six services on it |
| `packages/py-otel/` | a *different* concern: W3C context across Redis-Stream boundaries |
| `deployment/k8s/base/observability-config.yaml` (deployment repo) | the collector, its PHI allow-list, and Prometheus |

## Using it

```python
from hope_obs import ObservabilityConfig, configure_observability, shutdown_observability, get_logger

def create_app() -> FastAPI:
    app = FastAPI()
    configure_observability(app, ObservabilityConfig.from_env("myservice"))
    ...
```

That one call configures JSON logging, installs the request-context and access-log middlewares,
builds the tracer provider, instruments FastAPI and httpx, and passes the PHI hook. It **never
raises**. `shutdown_observability(app)` flushes on teardown.

A worker — anything without a FastAPI app — uses the sibling:

```python
from hope_obs import configure_worker_observability
obs = configure_worker_observability(config)   # same logging AND a real TracerProvider
...
obs.shutdown()                                  # wire into your SIGTERM path
```

A service whose own settings are the source of truth builds the config with
`dataclasses.replace(ObservabilityConfig.from_env("svc"), log_level=settings.log_level, ...)`.
That adapter belongs in the service; the implementation does not.

## The rules, and the reason each one exists

Each of these was a live defect before TASK-987. The reason is the part worth keeping.

### 1. An endpoint is the only enable signal

`OTEL_EXPORTER_OTLP_ENDPOINT` present ⇒ tracing on. **There is no boolean.**

Before this, six services had six shapes of enable flag, and four of them shipped with tracing
switched off in the only live environment. NLP was the sharpest case: the platform config supplied
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_ENABLED=true` **and** `OTEL_METRICS_ENABLED=true`, and
NLP still exported nothing, because it read only `NLP_OTEL_ENABLED`. Three correct variables, zero
telemetry, no warning. A flag that can contradict the endpoint beside it eventually does.

The legacy `*_OTEL_ENABLED` names are honoured for one release as an explicit OFF-veto, then
removed — see the deprecation register.

### 2. A reachable collector is never a boot dependency

`configure_observability` never raises. Note the two distinct failure modes, because conflating them
produces a test nobody can write:

| Failure | Behaviour |
|---|---|
| **Configuration** — exporter construction, instrumentation, a malformed endpoint | caught, warned, `tracer_provider = None`, tracing off; a partly built provider is shut down, not leaked |
| **Runtime export** — a valid endpoint nothing is listening on | tracing stays **ON**; OTLP/gRPC connects lazily, so this is invisible at configure time and spans buffer until the collector returns |

Probing the collector at startup to collapse these would make it a boot dependency. Don't.

### 3. Logging is configured before anything that can fail

So a failure to instrument never costs a service its structured logging.

### 4. structlog with a stdlib bridge

`ProcessorFormatter` means third-party records — `httpx`, `uvicorn`, `transformers` — come out as
JSON through the same chain. Five of six services previously emitted those unstructured next to
their own JSON, and NLP emitted plain text for everything because a `JsonFormatter` was written and
never installed. `configure_logging` is idempotent.

### 5. Event names, not sentences

`<service>.<area>.<event>`, snake_case, a stable literal; every variable is a field.

```python
logger.info("stt.session.started", session=redact_id(sid), duration_ms=12)   # yes
logger.info(f"started session {sid} in 12ms")                                # no
```

**Never** `extra={"message": ...}` — `message` is a reserved `LogRecord` attribute and stdlib
logging raises `KeyError` the moment that logger is enabled. A real crash sat in
`harness.temporal.activities` behind exactly this, invisible only because harness logging was never
actually configured in tests.

### 6. Every line carries its context

`timestamp`, `level`, `logger`, `event`, `service` always; `traceId`, `spanId`, `request_id`,
`tenant_id` when they exist. `traceId`/`spanId` are **absent**, not `"0"`, outside a span.
`tenant_id` is bound only when `X-Tenant-Id` is present — the middleware never invents one and never
defaults to a tenant.

### 7. One log path: stdout → Alloy → Loki

Do not export logs over OTLP. Alloy already tails every pod's stdout, so an OTLP log pipeline is a
second copy with a different shape — four services shipped both. Traces and metrics go over OTLP.
Correlation survives through `traceId` on the JSON line plus Grafana's derived field.

### 8. Workers get a real TracerProvider

Not just a logger provider. STT's batch worker had logs exported and no tracer, so its spans were
non-recording and — with no active span — its log lines carried no trace id either. A batch
transcription could not be joined to the request that enqueued it.

### 9. Know what survives the collector

The collector's `redaction/phi` processor is an **allow-list** over traces, metrics and logs.
Anything not named in it is dropped.

> **But no Python log reaches it any more.** Rule 7 sends every Python log line to stdout for Alloy,
> which does no content inspection at all (`stage.cri {}` and nothing else) — so the collector's
> allow-list protects **traces and metrics**, and the log plane's only control is emitter-side
> discipline: rule 5, rule 6, and `redact_id`. Do not read this section as "my log lines are
> filtered". They are not. The collector's `logs` pipeline still exists and now carries only the
> NestJS gateway.

Consequences that surprise people:

- `exception.message` and `exception.stacktrace` are **not** allowed — they embed payloads. An
  exception's *type* reaches Tempo; its message does not. Put the (PHI-free) detail on the log line.
- A bespoke attribute name is silently dropped. NLP's metrics carried `model`, `entity_type` and
  `label` and arrived stripped of all three. Use the `hope.*` namespace, and add the key to the
  allow-list in the deployment repo **in the same change** as the emitter.

### 10. `hope_obs` has no metrics path

Prometheus is the metrics plane; every service exposes `/metrics` and Prometheus scrapes it.
`apps/nlp` additionally keeps its own OTel `MeterProvider` — a **named** exception, because it is
the only consumer and an abstraction for one caller is not worth building. A second service growing
one fails the parity gate.

### 11. Imports stay light

FastAPI, Starlette and the OTLP exporter are all imported lazily or under `TYPE_CHECKING`, so a
worker with no FastAPI can import the package and a service with no endpoint never loads gRPC.
`import hope_obs` costs 350 modules; before the exporter was made lazy it cost 498, including the
whole `grpc._cython.cygrpc` stack.

## Adding a new Python service

1. Declare `hope-obs` in `pyproject.toml` `dependencies` **and** `[tool.uv.sources]`
   (`hope-obs = { workspace = true }`).
2. Add `../../packages/py-obs/src` to `[tool.pytest.ini_options] pythonpath`, and `hope_obs` to
   `assert_source_tree([...])` in the service's `conftest.py`.
3. **`COPY packages/py-obs ./packages/py-obs` in the Dockerfile.** Miss this and the image fails at
   `uv sync --frozen` with `Distribution not found`. Five of six services shipped without it because
   only `apps/text` had a test that could see it.
4. Call `configure_observability` in `create_app()`.
5. Re-run `uv lock` from the repo root.
6. Add the service to `tests/contracts/test_observability_parity.py`'s service list.

## Commands

```bash
pnpm py-obs:test          # the package's own suite
pnpm py-obs:lint          # ruff
pnpm py-obs:typecheck     # mypy
pnpm <svc>:test           # a service's suite, which the parity gate runs within
```

## Related

- [`../telemetry-phi-guardrails.md`](../telemetry-phi-guardrails.md) — the PHI rules for every new emitter
- [`./README.md`](./README.md) — dashboards, alert rules, and the still-missing paging path
- `packages/py-obs/README.md` — the package's own reference
- `packages/py-otel/README.md` — W3C context across Redis-Stream boundaries
- `.claude/rules/06-python-services.md` — the wider Python service conventions
- `docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md` — the review this came from, findings F-01…F-23
