# TASK-987 — Python Logging & Tracing Standard

| | |
|---|---|
| **Status** | In Progress — Wave 0 |
| **Type** | `infrastructure` (+ `bugfix` for the P0 items) |
| **Branch** | `dev-2.2` |
| **Scope** | `apps/{stt,text,guardrail,nlp,harness,tts}`, new `packages/py-obs`, and the `arca/hope-v2-deployment` repo |
| **Created** | 2026-09-18 |
| **Related** | `docs/operations/telemetry-phi-guardrails.md`, `docs/operations/observability/README.md`, `packages/py-otel/README.md`, `.claude/rules/06-python-services.md`, `.claude/rules/09-infrastructure-devops.md` |

---

## 1. Requirement Analysis

**Ask:** establish best-practice logging and tracing for every Python service, after a review of
what each one does today.

**What this ticket delivers:**

1. A recorded, evidence-backed review of the six Python services' logging/tracing posture (§2).
2. A single normative standard, implemented once as a shared package (`packages/py-obs`,
   `hope_obs`) rather than restated six times (§3).
3. A multi-agent execution plan with disjoint file ownership, per-lane model tiers, self-contained
   briefs and merge ordering (§4-§7).

**What this ticket does NOT do:**

- It does not change the PHI policy. `docs/operations/telemetry-phi-guardrails.md` stands; this
  ticket corrects one stale paragraph in it (F-14) and makes the policy reachable from one place
  in code.
- It does not add new signals, dashboards, SLOs or alert rules. Coverage of what already exists
  comes first; new measurement is a later ticket.
- It does not build a paging path. That gap is real and documented in
  `docs/operations/observability/README.md`; it is out of scope here.

**Definition of done for the ticket as a whole:** all six services configure logging and tracing
through `hope_obs` and nothing else; tracing is ON for all six in `hope-v2-dev`; a CI parity test
fails if a service drifts back; the standard is written down in
`docs/operations/observability/python-logging-and-tracing.md` and indexed from
`.claude/rules/06-python-services.md`.

---

## 2. Current State Evaluation

Reviewed 2026-09-18 against `dev-2.2` @ `0ca3bf8c3` and `arca/hope-v2-deployment@main`
(local checkout `~/Desktop/igglo/ARCAAI/hope-v2-deployment`).

### 2.0 What is already good — do not regress it

- `packages/py-otel` (`hope_otel`) solves W3C context across the Redis-Stream boundary that
  `FastAPIInstrumentor` cannot see, and is pinned to the same golden traceparent literal as its
  TypeScript twin. Consumers: `apps/text/src/text/api/endpoints/stream.py`,
  `apps/text/src/text/services/task_manager.py`, `apps/stt/src/stt/streaming/redis_streams.py`.
- `docs/operations/telemetry-phi-guardrails.md` is a genuinely good policy: four independent
  layers, allow-list not deny-list, and the standing rule that no Prometheus metric carries a
  tenant label.
- The deployed OTel Collector is **stronger** than the doc claims: `redaction/phi` is an
  *allow-list* (`allow_all_keys: false`, ~35 allowed keys plus `blocked_values` regexes) applied
  to **all three pipelines** and ordered **before** `batch`, so nothing unredacted is ever
  buffered. Source: `deployment/k8s/base/observability-config.yaml`.
- `apps/harness/src/harness/temporal/worker.py:316` installs its own `TracerProvider` for a
  non-FastAPI entrypoint. That is the correct worker pattern and the model for F-04.
- `apps/text` is the fleet's reference implementation on almost every axis, and its pure-ASGI
  middlewares carry the measurement that justified them.

### 2.1 Findings

Severity: **P0** = observability is absent or wrong in the live environment · **P1** = structural
divergence that will keep reproducing defects · **P2** = correctness/cost/doc issues.

#### F-01 (P0) — Four of six services emit no traces in `hope-v2-dev`

| Service | Enable signal read by the code | Set anywhere in `deployment/k8s/**`? |
|---|---|---|
| stt | `OTEL_ENABLED` (+ `OTEL_EXPORTER_ENDPOINT`) | YES — `overlays/dev/kustomization.yaml:440-441` |
| text | endpoint presence (`TEXT_OTEL_EXPORTER_ENDPOINT`) | YES — `overlays/dev/kustomization.yaml:255` |
| guardrail | `GUARDRAIL_V2_OTEL_ENABLED` | **NO** — hardcoded `"false"` at `base/guardrail.yaml:66`, no overlay patch |
| nlp | `NLP_OTEL_ENABLED` | **NO** — the name appears nowhere in the manifests |
| harness | `HARNESS_OTEL_ENABLED` | **NO** — the name appears nowhere in the manifests |
| tts | `TTS_OTEL_ENABLED` | **NO** — the name appears nowhere in the manifests |

All four default to `False` in their own settings, so the instrumentation they carry is dead code
in the only live environment. Guardrail's own module docstring
(`apps/guardrail/src/guardrail/core/observability.py:1-24`) calls it "the most compliance-sensitive
service in the fleet" — it was instrumented and then shipped switched off.

#### F-02 (P0) — NLP: three correct OTel variables, zero telemetry, no warning

`hope-platform-config` (which `nlp` consumes via `envFrom`, `base/nlp.yaml:172-176`) sets
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_ENABLED=true` and `OTEL_METRICS_ENABLED=true`.
NLP still exports nothing, because `setup_opentelemetry` returns at its first line
(`apps/nlp/src/nlp/core/observability.py:69`) on `settings.service.otel_enabled`, whose
`AliasChoices` list contains **only** `NLP_OTEL_ENABLED`
(`apps/nlp/src/nlp/core/config.py:244`). The operator set every variable they could reasonably
be expected to set and got silence.

This is the concrete argument for F-11's single enable contract: a boolean that can contradict the
endpoint beside it will eventually contradict it.

#### F-03 (P0) — NLP emits plain-text logs; its trace correlation is dead code

`apps/nlp/src/nlp/core/logging.py:7` defines `JsonFormatter`, which reads `otelTraceID` /
`otelSpanID` / `otelTraceFlags` off the record. It is **never installed**: the single console
handler is given `logging.Formatter(cls.SIMPLE_FORMAT)` at line 96, i.e.
`[%(asctime)s] %(levelname)s - %(name)s :: %(message)s`. Grep confirms `JsonFormatter` has exactly
one occurrence in the whole service — its own definition.

Consequences: Loki stores unparsed text for NLP; no field is queryable; the traceId plumbing has
never executed; and `apps/nlp/tests/test_task883_logging_retirement.py` passes anyway because it
tests the retirement of the file handlers, not the formatter.

#### F-04 (P1) — The STT batch worker exports logs but installs no tracer

`apps/stt/src/stt/worker.py:58-67` calls `setup_telemetry_logs` only. There is no
`TracerProvider` in the worker process, so any span it opens is non-recording, and — because
`LoggingInstrumentor` reads the *current span* — its log records carry no `traceId` either. A batch
transcription cannot be joined to the request that enqueued it.

Contrast `apps/harness/src/harness/temporal/worker.py:312-316`, which imports
`build_tracer_provider` precisely because it has no FastAPI app. Harness is right; STT is not.

#### F-05 (P1) — Six logging stacks

| | stt | text | harness | tts | guardrail | nlp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| JSON output | YES | YES | YES | YES | YES | **NO** (F-03) |
| stdlib / 3rd-party logs enter the same chain | YES (`ProcessorFormatter`) | partial | partial | partial | partial | YES (root handler) |
| `traceId`/`spanId` on log lines | YES | YES | YES | **NO** | **NO** | **NO** (dead) |
| `merge_contextvars` | YES | YES | YES | YES | **NO** | n/a |
| Request-ID middleware | YES | YES | **NO** | **NO** | **NO** | **NO** |
| Access log with latency | YES | YES | **NO** | **NO** | **NO** | **NO** |
| PHI `server_request_hook` wired | **NO** | YES | YES | YES | YES | YES |
| `force_flush` on shutdown | **NO** | YES | YES | YES | YES | **NO** |
| Idempotent `setup_logging` | YES | **NO** | **NO** | **NO** | **NO** | **NO** |

Only STT routes stdlib logging through the structlog chain, so in the other five a `httpx`,
`uvicorn.error` or `transformers` record lands unstructured next to the JSON. Guardrail has no
`merge_contextvars` at all, so even if something bound a request id it could never surface.

#### F-06 (P1) — Request correlation exists in two services of six

`RequestIDMiddleware` + `RequestLoggingMiddleware` exist only in `apps/stt/src/stt/core/middleware/`
and `apps/text/src/text/api/middleware/`. Guardrail, NLP, harness and TTS have an `auth.py` and
nothing else: no request id, no echoed `X-Request-ID`, no access log, no latency field.

`uvicorn.access` is additionally **disabled** in text/tts (and its handlers cleared in
text/harness), which is correct where a structured access log replaces it and a silent gap where
one does not.

#### F-07 (P1) — `tenant_id` is bound into log context nowhere

The only `bind_contextvars` call sites in the fleet are the two request-id middlewares, and both
bind `request_id` alone. `.claude/rules/00-project-context.md` makes `X-Tenant-Id` mandatory on
every internal tenant-scoped call specifically so guardrail decisions are attributable — the logs
cannot currently attribute them. `hope.tenant_id` is already on the collector's allow-list, so the
telemetry plane is ready for it; only the emitters are missing.

#### F-08 (P1) — STT still uses `BaseHTTPMiddleware` for both middlewares

`apps/text/src/text/api/middleware/request_id.py:8-14` records the measurement: three stacked
`BaseHTTPMiddleware` layers cost ~2.2 ms CPU/request, about 30% of the per-request budget on a
service running at 96-98% of one core, and text moved both middlewares to pure ASGI.
`apps/stt/src/stt/core/middleware/{request_id,logging}.py` are still `BaseHTTPMiddleware` — on the
most latency-sensitive service in the fleet.

#### F-09 (P2) — Resource-attribute divergence

| Service | `deployment.environment` |
|---|---|
| stt | resolved `DEPLOYMENT_ENVIRONMENT` → `NODE_ENV` → **`development`**, and emits both the legacy and the `.name` spelling (`core/telemetry.py:42-70`) — the correct implementation |
| text | function default `"development"`; callers pass `settings.otel_deployment_environment` |
| tts / harness | from settings; **function default `"production"`** in `tts/core/observability.py:81` and `text/core/telemetry.py:28` — a laptop that calls the helper directly stamps spans `production` |
| guardrail | **no environment attribute at all** (`core/observability.py:93-99`) — rescued in-cluster only because the collector's `resource` processor uses `action: insert` |

#### F-10 (P2) — Logs reach Loki twice for four services

Alloy tails every pod's stdout in the namespace and writes to Loki
(`deployment/k8s/base/alloy.yaml`, `loki.source.file "k8s_pods"` → `loki.write "default"`).
stt / text / tts / nlp **also** export logs over OTLP → collector → Loki. Two copies, two label
sets, two shapes; guardrail and harness ship one. Nobody chose this — it accumulated service by
service.

Related, and to be **verified in a running cluster before it is asserted** (task V-2): with
`JSONRenderer`, the entire structured payload becomes the log *message*, which OTel's
`LoggingHandler` maps to the record **body**, while `redaction/phi` allow-lists *attributes*.
If that holds, the PHI allow-list never inspects the payload on the OTLP log path — strong for
traces, nominal for log bodies. Deleting the OTLP log path (§3 R-5) makes the question moot.

#### F-11 (P2) — Six shapes of enable contract, all in `turbo.json#globalEnv`

`OTEL_ENABLED` (stt) · no flag at all, endpoint presence is the signal (text, deliberately —
`apps/text/src/text/core/config.py:205`) · `GUARDRAIL_V2_OTEL_ENABLED` · `NLP_OTEL_ENABLED` ·
`HARNESS_OTEL_ENABLED` · `TTS_OTEL_ENABLED`. Text's model is the right one and is already
documented as such in `base/config/text.env:25`; F-02 is what the other five cost.

#### F-12 (P2) — No sampling anywhere

No `Sampler`, `ParentBased`, `TraceIdRatioBased` or `OTEL_TRACES_SAMPLER` appears in any service,
any env sample, or any manifest. Every service is at 100% head sampling. Acceptable at dev volume;
it is not a production posture, and adding it later per-service is how one service quietly stays
at 100%.

#### F-13 (P2) — STT lacks the PHI `server_request_hook` every other service passes

`apps/stt/src/stt/core/telemetry.py` never passes `server_request_hook`. Guardrail's docstring
records that "the hook existing but never being *passed*" was the exact defect already fixed in
NLP; STT is the remaining instance, on the one service whose payloads are clinical audio.

#### F-14 (P2) — `telemetry-phi-guardrails.md` §2 no longer matches the deployment

The doc prescribes a **deny-list** (`attributes/phi-redact` + `transform/phi-redact-prefixes`
deleting known-bad `gen_ai.*` keys). The deployed collector implements an **allow-list**
(`redaction/phi`) over all three pipelines. Reality is stronger than the doc, which is the
dangerous direction to be stale in: a reader assumes a new attribute survives by default. It does
not — anything not allow-listed is dropped.

#### F-15 (P2) — `/metrics` is behind a flag in five services, unconditional in one

`metrics_enabled` (default `True`) gates `/metrics` in stt/guardrail/nlp/harness/tts; text exposes
it unconditionally and documents why ("a metrics endpoint that can be switched off from an env file
is an observability gap nobody notices until they need it",
`apps/text/src/text/main.py:467-469`). Prometheus scrapes all six plus `stt-worker`
unconditionally (`observability-config.yaml` job list), so a `false` anywhere presents as
`TargetDown`. No service has it false today; the flag is a live foot-gun, not a live defect.

---

## 3. The Standard (normative)

One implementation, `packages/py-obs` → `hope_obs`, sibling to `py-env` and `py-otel` and built for
the same reason: `py-otel`'s own README records that six duplicated copies existed because a shared
package meant contending on the single root `uv.lock`. That contention is a scheduling problem
(§4), not a reason to keep six copies.

### R-1 — Package layout and public surface

```
packages/py-obs/
├── pyproject.toml                 # deps: structlog, opentelemetry-{api,sdk,exporter-otlp-proto-grpc},
│                                  #       opentelemetry-instrumentation-{fastapi,httpx,logging}
├── README.md
├── src/hope_obs/
│   ├── __init__.py                # the ONLY import surface services use
│   ├── config.py                  # ObservabilityConfig
│   ├── logging.py                 # configure_logging / get_logger
│   ├── tracing.py                 # build_tracer_provider / instrument_fastapi / shutdown
│   ├── middleware.py              # RequestContextMiddleware, AccessLogMiddleware (pure ASGI)
│   ├── phi.py                     # phi_sanitization_hook, redact_id
│   └── runtime.py                 # configure_observability / configure_worker_observability
└── tests/                         # pytest, no live collector, no network
```

**This signature block is the interface contract. Lanes implement against it verbatim; a lane that
needs it changed raises it to the orchestrator rather than diverging locally.**

```python
# hope_obs/config.py
@dataclass(frozen=True)
class ObservabilityConfig:
    service_name: str
    service_version: str = "0.0.0"
    service_namespace: str = "hope"
    deployment_environment: str = "development"
    otlp_endpoint: str | None = None      # PRESENCE is the enable signal — there is no boolean
    log_level: str = "info"
    traces_sampler_ratio: float = 1.0

    @property
    def tracing_enabled(self) -> bool: ...        # bool(self.otlp_endpoint)
    @property
    def insecure(self) -> bool: ...               # NOT endpoint.startswith("https://")

    @classmethod
    def from_env(cls, service_name: str, *, service_version: str = "0.0.0") -> "ObservabilityConfig": ...

# hope_obs/__init__.py — the whole public surface
configure_observability(app: FastAPI, config: ObservabilityConfig) -> None
shutdown_observability(app: FastAPI) -> None
configure_worker_observability(config: ObservabilityConfig) -> WorkerObservability   # .shutdown()
configure_logging(config: ObservabilityConfig) -> None        # idempotent
get_logger(name: str) -> structlog.stdlib.BoundLogger
get_tracer(name: str) -> opentelemetry.trace.Tracer
bind_request_context(**fields: str) -> None
redact_id(value: object | None) -> str
ObservabilityConfig
```

### R-2 — One env contract, replacing the six in F-11

| Variable | Meaning | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector address. **Its presence is the enable signal.** | unset → tracing off |
| `OTEL_SERVICE_NAME` | Overrides the `service_name` argument | the argument |
| `DEPLOYMENT_ENVIRONMENT` → `NODE_ENV` | Resource environment, both spellings emitted | `development` |
| `OTEL_TRACES_SAMPLER_ARG` | Head-sampling ratio | `1.0` |
| `LOG_LEVEL`, overridden by `<SVC>_LOG_LEVEL` | Log level | `info` |

There is **no** `*_OTEL_ENABLED` boolean. The five that exist are deprecated per
`docs/operations/deprecation-register.md` (honoured with a warning for two releases, then removed)
— never silently dropped, because a manifest that still sets one must keep working until it is
updated. The *default* is off in both worlds: no endpoint, no export.

Tracing stays failure-tolerant: `configure_observability` never raises. An unreachable or
misconfigured collector degrades to no-tracing and logs a warning. A reachable observability
backend is never a boot or request-path dependency — this is already the posture in tts/guardrail/
harness and must not regress.

### R-3 — Logging shape

structlog with `ProcessorFormatter` bridging stdlib (STT's shape — the only one that captures
third-party records), chain fixed in this order:

```
merge_contextvars → add_otel_context → add_logger_name → add_log_level
→ PositionalArgumentsFormatter → TimeStamper(iso, utc) → StackInfoRenderer
→ format_exc_info → UnicodeDecoder → JSONRenderer
```

- `configure_logging` is **idempotent** (STT's `_SETUP_DONE` guard) — a second call from a test or
  a worker re-entry must not double handlers.
- `uvicorn.access` disabled (`AccessLogMiddleware` replaces it); `uvicorn.error` handlers cleared
  and `propagate = True`.
- **Event names, not sentences.** `<service>.<area>.<event>`, snake_case, a stable literal — every
  variable is a field. `logger.info("stt.session.started", session=redact_id(sid), ms=12)`, never
  an f-string. This is already the convention in harness (`harness.otel.shutdown_complete`) and
  text (`request.complete`); R-3 makes it the rule.
- Fields present on every line: `timestamp`, `level`, `logger`, `event`, `service`. Present when
  available: `traceId`, `spanId`, `request_id`, `tenant_id`.
- **Never log clinical content.** No transcript, prompt, completion, summary, note or entity text
  on any line, at any level, including `DEBUG`. Identifiers go through `redact_id`
  (promoted from `apps/stt/src/stt/core/logging.py:120-133`), which is the only sanctioned way an
  id reaches a log line.

### R-4 — Request context, once, in pure ASGI

`RequestContextMiddleware` (never `BaseHTTPMiddleware`, per F-08) binds for the life of the
request and clears in `finally`:

- `request_id` — `X-Request-ID` inbound or a fresh uuid4, echoed on the response (replace, never
  append — see the note in `text/api/middleware/request_id.py:38-52`).
- `tenant_id` — `X-Tenant-Id` when present. Absent is absent; the middleware never invents one and
  never defaults to a tenant (`.claude/rules/00-project-context.md` — a "default tenant" knob is
  the failure mode this rule exists to catch).

`AccessLogMiddleware` emits `request.start` / `request.complete` / `request.failed` with
`method`, `path`, `status_code`, `duration_ms`. `duration_ms` is measured to **response start**,
not body end — moving it would silently redefine the field and turn SSE request latency into
generation duration (`text/api/middleware/logging.py:8-16`).

### R-5 — One log path: stdout → Alloy → Loki

Delete OTLP log export from every service. Alloy already tails every pod in the namespace, so the
OTLP log pipeline is a second copy (F-10) with a different shape and an open question about
body-vs-attribute redaction. Traces and metrics continue over OTLP.

Correlation survives: `traceId` is on the JSON line (R-3), and Grafana joins Loki → Tempo with a
derived field on it. Grafana derived-field config is a `hope-v2-deployment` change (lane D2).

### R-6 — Worker parity

Every non-FastAPI entrypoint calls `configure_worker_observability`, which installs the **same**
logging config **and a real `TracerProvider`** (F-04), returning a handle whose `.shutdown()` flushes
on SIGTERM. Service name is `<service>-worker`, using STT's existing no-double-suffix rule
(`apps/stt/src/stt/worker.py:45-56`) so an operator-set `OTEL_SERVICE_NAME` is not mangled.
Applies to: `stt.worker` (Dramatiq) and `harness.temporal.worker` (already compliant — it becomes
a consumer of the shared helper, not a rewrite).

### R-7 — Spans and attributes

- Namespaces unchanged: `gen_ai.*` for LLM generation (text only), `hope.*` for everything else.
- **Know what survives.** The collector allow-list drops anything not named in
  `observability-config.yaml`. Notably **`exception.message` and `exception.stacktrace` are NOT
  allowed** — an exception's type reaches Tempo, its message does not. Do not design a debugging
  workflow that assumes otherwise; put the (PHI-free) detail on the log line instead.
- A new attribute means a deliberate edit to the collector allow-list in the deployment repo, in
  the same change as the emitter.

### R-8 — Sampling

`ParentBased(TraceIdRatioBased(ratio))`, ratio from `OTEL_TRACES_SAMPLER_ARG`, default `1.0`,
declared once in `hope_obs`. `overlays/dev` stays at `1.0`. A service never picks its own sampler.

### R-9 — What stays out of telemetry

Unchanged from `telemetry-phi-guardrails.md` and restated because it is the rule most easily lost
in a refactor: no Prometheus label is a tenant, user, patient or consultation identifier; the
telemetry plane never carries clinical content; per-tenant analytics live in the Postgres usage
ledger. `hope.tenant_id` as a *span/log* attribute is allowed (it is on the collector allow-list);
as a *Prometheus label* it is forbidden. These are different planes with different cardinality and
access properties — do not harmonise them.

---

## 4. Shared surfaces — orchestrator-owned, never touched by a lane

A new `packages/py-*` workspace member touches single files that six parallel lanes would each
need. Per `.claude/rules/14-multi-agent-worktrees.md` §3 these belong to the parent session, and
they are the reason Wave 0 is sequential:

| Surface | Why it cannot be parallel |
|---|---|
| `pyproject.toml` (root) `[tool.uv.workspace].members` | One list, six would-be editors |
| `uv.lock` (root) | One lock for the whole workspace; `uv lock` must run once, from the primary checkout |
| `package.json` (root) | The `py-obs:{test,lint,lint:fix,typecheck,format,format:check}` block, mirroring the existing `py-otel:*` block at lines 231-236 |
| `turbo.json#globalEnv` | Adding `OTEL_TRACES_SAMPLER_ARG`; deprecating the five `*_OTEL_ENABLED` names |
| `.gitlab/ci/test.yml` | Six jobs each need `pip install packages/py-obs` beside the existing `py-env`/`py-otel` lines |
| `.claude/rules/06-python-services.md` | Rule text lands once, at the end |
| `pnpm install`, `pnpm setup:python`, any `db:*`, any Docker/infra command | Standing rule |

`scripts/setup-python-env.sh` needs **no** edit — it globs `packages/py-*` (line 479) and
editable-installs whatever it finds.

Per-service `pyproject.toml` files are **not** shared: each service lane edits its own.

---

## 5. Lane partition — disjoint ownership

Nine lanes in four waves. Every path is owned by exactly one lane in any given wave.

| Lane | Wave | Owns (exclusive) | Model / effort | Worktree |
|---|---|---|---|---|
| **F** — foundation | 0 | `packages/py-obs/**` (new) | `opus-5` / **high** | `../hope-v2-t987-obs` |
| **D1** — turn telemetry on | 0 | `hope-v2-deployment`: `base/guardrail.yaml`, `overlays/dev/kustomization.yaml` | `sonnet-5` / medium | separate repo, own branch |
| **A** — stt | 1 | `apps/stt/**` | `sonnet-5` / **high** | `../hope-v2-t987-stt` |
| **B** — text | 1 | `apps/text/**` | `sonnet-5` / medium | `../hope-v2-t987-text` |
| **C** — guardrail | 1 | `apps/guardrail/**` | `sonnet-5` / medium | `../hope-v2-t987-guardrail` |
| **E** — nlp | 1 | `apps/nlp/**` | `sonnet-5` / **high** | `../hope-v2-t987-nlp` |
| **G** — harness | 1 | `apps/harness/**` | `sonnet-5` / medium | `../hope-v2-t987-harness` |
| **H** — tts | 1 | `apps/tts/**` | `sonnet-5` / medium | `../hope-v2-t987-tts` |
| **P** — parity gate | 2 | `tests/contracts/test_observability_parity.py` (new) | `sonnet-5` / high | `../hope-v2-t987-parity` |
| **D2** — env unification + Grafana | 3 | `hope-v2-deployment`: config maps, Grafana derived field, collector allow-list | `sonnet-5` / medium | separate repo, own branch |
| **V** — verification & review | 3 | read-only; writes only §8 of this README | `opus-5` / **high** | none (read-only) |

### Tier rationale (`.claude/rules/14-multi-agent-worktrees.md` §1)

- **F is `opus-5`/high** because every other lane consumes its API. It is the stage whose verdict
  the whole fan-out acts on, and the rule is never to downshift that stage.
- **A, E are `sonnet-5`/high**: STT carries four changes with real coupling (worker tracer, PHI
  hook, `BaseHTTPMiddleware` → ASGI, `redact_id` moving to the shared package); NLP is a
  stdlib → structlog conversion plus an enable-flag trap plus dead code removal.
- **B, C, G, H are `sonnet-5`/medium**: mechanical adoption of a contract that already exists by
  the time they run, against a reference implementation they can read.
- **D1/D2 are `sonnet-5`/medium**: small YAML edits, but they change a live cluster, and the
  verdict ("does the overlay render what I think") is mechanically checkable with
  `kustomize build`.
- **V is `opus-5`/high**: the deciding stage. It is the one that says "this is correct and safe to
  merge", and it must be adversarial about F-10/V-2 in particular.
- **P is `sonnet-5`/high**: writing a test whose whole job is to fail on drift needs care about
  what it actually asserts; it is cheap to get superficially green and useless.

### Explicit non-overlap rules

1. **No lane edits another lane's `apps/<service>/**`.** If lane B believes guardrail needs a
   change, it reports it; it does not make it.
2. **No Wave-1 lane edits `packages/py-obs/**`.** The package is frozen after F merges. A needed
   change is raised to the orchestrator, who lands it and tells the other lanes to rebase.
3. **No lane touches §4's shared surfaces**, including its own service's entry in the root
   `package.json`, `turbo.json` or `.gitlab/ci/*`.
4. **No lane runs `pnpm install`, `uv lock`, `pnpm setup:python`, `db:*`, or any Docker/infra
   command.** A sibling lane's test run dies with it.
5. **No `git stash` in a worktree** — the stash stack is repo-wide. Baseline with
   `git checkout HEAD~1 -- <path>`.
6. Lanes D1/D2 work in the **other repository** and therefore never collide with anything above.

---

## 6. Lane briefs

A subagent starts with an EMPTY context and reads nothing of the orchestrator's conversation. Every
spawn prompt is therefore **§6.0 (common preamble) + the lane's own block, verbatim**. Do not
paraphrase, and do not assume the agent can see this file unless the brief tells it to open it.

### 6.0 Common preamble (prepend to every lane brief)

> You are working on **TASK-987 — Python Logging & Tracing Standard** in the HOPE monorepo.
>
> **Working directory:** `<worktree path>` (a git worktree branched from `dev-2.2`).
> **Target branch for the final merge:** `dev-2.2` — the ORCHESTRATOR merges; you never merge,
> never switch branches, never push.
>
> **Read before you write, in this order:**
> 1. `docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md` — §2 (findings),
>    §3 (the normative standard, including the R-1 signature block), §5 (your boundary).
> 2. `.claude/rules/06-python-services.md` — FastAPI/pydantic-settings/test-layout conventions.
> 3. `.claude/rules/01-development-workflow.md` — TDD (failing test first, always see RED) and the
>    evidence requirement.
> 4. `docs/operations/telemetry-phi-guardrails.md` — the PHI rules. Non-negotiable.
>
> **Hard constraints:**
> - Edit ONLY the paths listed as yours. Anything else — including root `pyproject.toml`,
>   `uv.lock`, `package.json`, `turbo.json`, `.gitlab/ci/**`, `.claude/rules/**`, and any other
>   service's directory — belongs to the orchestrator or another lane. If you believe one must
>   change, STOP and report it; do not change it.
> - Do NOT run `pnpm install`, `uv lock`, `pnpm setup:python`, any `db:*` command, or any Docker /
>   `infra:*` command. Other lanes are running against the same machine.
> - Do NOT `git stash` — the stash stack is shared repo-wide. To get a baseline, commit first and
>   use `git checkout HEAD~1 -- <path>`.
> - A fresh worktree has no `node_modules` and no `dist/`. You do not need them: your gates are
>   Python-only and run through the shared conda env `arcaenv`.
> - Your suite MUST be run from your own worktree. Each service's `conftest.py` calls
>   `assert_source_tree([...], __file__)`, which aborts the run if a package resolves outside your
>   tree. If it fires, FIX the `pythonpath` entry in that service's `[tool.pytest.ini_options]` —
>   never delete the assertion.
> - Never log clinical content (transcript, prompt, completion, summary, note, entity text) at any
>   level, including DEBUG. Identifiers go through `hope_obs.redact_id`.
> - Commit your work in your worktree with a message starting `feat(task-987): ` or
>   `fix(task-987): `. Leave the worktree in place when you finish.
>
> **Return contract — your final message is DATA for the orchestrator, not prose.** Report exactly:
> (1) branch name and commit SHAs; (2) every file created/modified/deleted; (3) each gate command
> you ran with its **pasted actual output** (a claim with no output pasted is not a result);
> (4) anything you found that belongs to another lane, as a list of observations — never a change;
> (5) any point where you diverged from §3's contract, and why.

### 6.1 Lane F — `packages/py-obs` (Wave 0, `opus-5` / high)

**Owns:** `packages/py-obs/**` (new directory, nothing else exists in it).

**Task:** build the shared package exactly to §3 R-1..R-8. Deliverables:

1. `pyproject.toml` — package name `hope-obs`, module `hope_obs`, setuptools + `src/` layout.
   Copy the shape of `packages/py-otel/pyproject.toml`. Declare `structlog`,
   `opentelemetry-api`, `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-grpc`,
   `opentelemetry-instrumentation-fastapi`, `opentelemetry-instrumentation-httpx`. FastAPI/Starlette
   are **typing-only** imports guarded by `TYPE_CHECKING` — the package must import cleanly in a
   worker process with no FastAPI installed.
2. `src/hope_obs/` per the R-1 tree, implementing the R-1 signature block verbatim.
3. `tests/` — pytest, hermetic, no network and no live collector. Cover at minimum:
   - `ObservabilityConfig.from_env` precedence: `OTEL_EXPORTER_OTLP_ENDPOINT` presence toggles
     `tracing_enabled`; `DEPLOYMENT_ENVIRONMENT` → `NODE_ENV` → `development`; `insecure` derived
     from the endpoint scheme, never from a separate flag.
   - `configure_logging` is idempotent (calling twice leaves exactly one root handler) and emits
     valid JSON carrying `timestamp/level/logger/event/service`.
   - A stdlib `logging.getLogger("httpx").warning(...)` record comes out as JSON through the same
     chain (this is the F-05 regression this package exists to prevent).
   - `traceId`/`spanId` appear when a span is active and are absent when none is
     (use an in-memory `TracerProvider` + `InMemorySpanExporter`).
   - `RequestContextMiddleware` binds `request_id` and `tenant_id`, echoes exactly one
     `X-Request-ID` response header (no duplicate on repeated sends), and clears contextvars on
     the exception path.
   - `AccessLogMiddleware` emits `request.complete` at response START with a `duration_ms`.
   - `configure_observability` **never raises** with an unroutable endpoint
     (`http://127.0.0.1:1`) and leaves `app.state.tracer_provider` set to `None`.
   - `redact_id` is stable, 12 hex chars, `"-"` for `None`/empty, and never returns the input.
   - Sampler is `ParentBased(TraceIdRatioBased(ratio))` with `OTEL_TRACES_SAMPLER_ARG` honoured.
4. `README.md` in the package, following `packages/py-otel/README.md`'s shape (Layout / Commands /
   How it works / Install / Related).

**Do not** modify any `apps/**` file, and do not add the package to the root workspace — the
orchestrator does that (§4).

**Gates (paste output):**
```bash
conda run -n arcaenv --no-capture-output pytest packages/py-obs/tests/ -v --tb=short
conda run -n arcaenv --no-capture-output ruff check packages/py-obs/src/ packages/py-obs/tests/
conda run -n arcaenv --no-capture-output mypy --config-file packages/py-obs/pyproject.toml packages/py-obs/src/
conda run -n arcaenv --no-capture-output black --check packages/py-obs/src/ packages/py-obs/tests/
```

**Also report:** the final signature block as implemented. If it differs from §3 R-1 in any way,
say so explicitly at the top of your report — six lanes are about to be briefed against it.

### 6.2 Lane D1 — turn telemetry on (Wave 0, `sonnet-5` / medium, other repo)

**Repo:** `~/Desktop/igglo/ARCAAI/hope-v2-deployment` (`arca/hope-v2-deployment`), branch off `main`.
**Owns:** `deployment/k8s/base/guardrail.yaml`, `deployment/k8s/overlays/dev/kustomization.yaml`.

**Task:** make tracing live for the four dark services (F-01) **using the enable flags exactly as
the code reads them today**. This lane deliberately does NOT anticipate the R-2 unification — that
is lane D2, after the services ship it. Getting telemetry on now is worth more than getting it on
once.

1. `base/guardrail.yaml:66` — `GUARDRAIL_V2_OTEL_ENABLED` is hardcoded `"false"` in **base**.
   Per `.claude/rules/09-infrastructure-devops.md`, base must be portable and environment identity
   lives in overlays: leave base defaulting OFF, and turn it on in `overlays/dev` alongside the
   others. Add `GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT=http://otel-collector:4317`.
2. `overlays/dev/kustomization.yaml` — add the enable + endpoint pairs for **nlp**
   (`NLP_OTEL_ENABLED=true`, and confirm the endpoint variable NLP's settings actually read),
   **harness** (`HARNESS_OTEL_ENABLED=true`, `HARNESS_OTEL_EXPORTER_ENDPOINT=...`), and **tts**
   (`TTS_OTEL_ENABLED=true`, `TTS_OTEL_EXPORTER_ENDPOINT=...`).
3. Verify each variable name against the SERVICE'S OWN settings class in the `hope-v2` checkout
   before you write it — F-02 is exactly the failure of setting a plausible name that no code
   reads. Read `apps/<svc>/src/<svc>/core/config*.py` and quote the field + alias in your report.
4. Put each literal in the config map the service actually consumes (`hope-<svc>-config` where one
   exists, otherwise a Deployment env patch like the existing `TEXT_OTEL_EXPORTER_ENDPOINT` patch
   at `overlays/dev/kustomization.yaml:248-258`). Use **name-based strategic-merge patches**, never
   index-based JSON6902 env patches — `patch-hygiene` is a blocking CI gate there.
5. Keep comments OUTSIDE any `patch: |` literal block — `kustomize edit` (run by `promote-dev`)
   duplicates comments inside patch literals.

**Gates (paste output):**
```bash
kustomize build deployment/k8s/overlays/dev > /tmp/t987-dev.yaml && echo RENDER_OK
grep -c 'OTEL' /tmp/t987-dev.yaml
for s in guardrail nlp harness tts; do echo "== $s"; awk "/name: hope-$s\$/,/^---/" /tmp/t987-dev.yaml | grep -i otel; done
```

**Do NOT** `kubectl apply`, `kubectl edit`, or sync Argo. Git is the only write path. Commit on a
branch and report; a human opens the MR.

### 6.3 Lanes A/B/C/E/G/H — per-service adoption (Wave 1)

Every service lane performs the **same six steps** against its own service. The per-service block
below lists only what is additional or different.

**Common steps (all six lanes):**

1. **Adopt the package.** Add `hope-obs` to `apps/<svc>/pyproject.toml` `dependencies` **and**
   `[tool.uv.sources]` (`hope-obs = { workspace = true }`), copying the two lines that already
   exist for `hope-env`. Add `"../../packages/py-obs/src"` to that service's
   `[tool.pytest.ini_options] pythonpath`, and add `"hope_obs"` to the `assert_source_tree([...])`
   list in its `conftest.py`. Do **not** run `uv lock` — the orchestrator ran it in Wave 0.
2. **Replace the service's own logging/observability modules** with calls into `hope_obs`. Keep
   `core/logging.py` and `core/observability.py` (or `core/telemetry.py`) as thin re-export shims
   only where an import path is used widely enough that rewriting every call site would balloon the
   diff. A shim is a one-release migration aid and must be registered in
   `docs/operations/deprecation-register.md` — but that file is a §4 shared surface, so do NOT edit
   it. LIST every shim you leave behind in your report and the orchestrator registers them.
3. **Wire the middlewares** — `RequestContextMiddleware` then `AccessLogMiddleware`, outermost
   first, in `create_app()`.
4. **Delete OTLP log export** (R-5) where the service has it; keep traces and metrics.
5. **Read settings through `ObservabilityConfig.from_env`** (R-2). Keep the service's existing
   `*_OTEL_ENABLED` field honoured **with a deprecation warning** for one more release — a live
   manifest still sets it. Never silently ignore it.
6. **Tests** (TDD — write them failing first): the service's app boots with no endpoint set and
   exports nothing; boots with an unroutable endpoint and still serves `/health`; a request
   produces one `request.complete` JSON line carrying `request_id` and `duration_ms`; an inbound
   `X-Request-ID` is echoed unchanged; an inbound `X-Tenant-Id` appears as `tenant_id` on the line.

**Gate for every service lane (paste output):**
```bash
pnpm <svc>:test        # e.g. pnpm guardrail:test
pnpm <svc>:lint
pnpm <svc>:typecheck
```

| Lane | Service | Additional work |
|---|---|---|
| **A** | stt | F-13: pass `phi_sanitization_hook` to `FastAPIInstrumentor` (it never has). F-04: `stt/worker.py` must call `configure_worker_observability` — a real `TracerProvider`, not just logs; keep the no-double-suffix rule at `worker.py:45-56`. F-08: both middlewares are replaced by the pure-ASGI ones from `hope_obs`; delete `core/middleware/{request_id,logging}.py`. Move `redact_id` to `hope_obs` and re-point every caller. Keep `hope_otel` Redis-Stream propagation exactly as is. Verify `tests/test_redis_streams_trace_task636.py` and `tests/unit/test_observability.py` still pass. |
| **B** | text | Lightest lane — text is already closest to the standard. Delete the duplicated `_add_otel_context`, `_configure_uvicorn_logging` and both middlewares in favour of `hope_obs`. `core/telemetry.py` is already a shim; keep it a shim. Preserve the `gen_ai.*` allow-list test (`tests/unit/test_phi_safe_telemetry.py`) and the `TelemetryPhiGuardConfig` boot guard untouched — they are a different control. Confirm `test_sse_trace_propagation_task636.py`, `test_request_id_middleware.py`, `test_request_logging.py` still pass; port their assertions rather than deleting them. |
| **C** | guardrail | F-05: gains `merge_contextvars` and `traceId`/`spanId` for the first time. F-09: gains `deployment.environment` (both spellings) — it currently emits none and relies on the collector filling it in. F-06: gains both middlewares. Keep the default-OFF invariant and the never-raises posture the module docstring describes. `tests/test_otel_tracing_task636.py` must keep passing. |
| **E** | nlp | Largest diff. F-03: delete the never-installed `JsonFormatter` and the whole `LoggingConfig` class; NLP moves to structlog via `hope_obs`. Keep `NLP_LOG_LEVEL` → `LOG_LEVEL` precedence and the numeric-or-name level parsing (both are real behaviours, documented in `core/logging.py:50-63`). F-02: `from_env` must see the endpoint the platform config already supplies; honour `NLP_OTEL_ENABLED` for one release with a deprecation warning. NLP is the only service with an OTel `MeterProvider` — **leave it in place**, retarget it at the shared resource, and report whether its metric attributes survive the collector allow-list (R-7). Verify `tests/test_observability.py` and `tests/test_task883_logging_retirement.py`. |
| **G** | harness | `core/observability.py` already splits `build_tracer_provider` from `setup_opentelemetry` — that split is the R-6 pattern; preserve it through the shared package. `temporal/worker.py:308-316` becomes a `configure_worker_observability` caller. Do NOT change workflow code in `temporal/workflows.py` or the interpreter: determinism and replay compatibility are at stake, and this ticket has no business there. Run the replay-compat tests and paste them. Keep `TracingInterceptor` wiring in `temporal/client.py` as is. |
| **H** | tts | F-05: gains `traceId`/`spanId` on log lines. `core/observability.py` is currently the hardened reference (never-raises + mandatory PHI hook) — that behaviour must survive the move, not be lost in it. The WebSocket endpoint `api/endpoints/stream_ws.py` stays uninstrumented (out of scope, documented); note in your report that it remains a trace gap. `tests/test_otel_tracing_task636.py` must keep passing. |

### 6.4 Lane P — parity gate (Wave 2, `sonnet-5` / high)

**Owns:** `tests/contracts/test_observability_parity.py` (new). Nothing else.

**Task:** a hermetic test that fails when a service drifts off the standard. Model it on the
repo's existing parity tests (`resourceType.enum-parity.test.ts`, `py-otel`'s golden-traceparent
suite). It must assert, for **all six** services, by static inspection — no app boot, no network:

- Each service imports its logging and tracing setup from `hope_obs` and defines no local
  `structlog.configure`, no local `TracerProvider(`, no local `_add_otel_context`.
- Each `create_app()` installs `RequestContextMiddleware` and `AccessLogMiddleware`.
- No service passes `server_request_hook=None` or omits it where it instruments FastAPI.
- No service constructs an `OTLPLogExporter` (R-5 — the log path is stdout).
- Every `apps/<svc>/pyproject.toml` declares `hope-obs` and lists `packages/py-obs/src` on
  `pythonpath`, and every `conftest.py` names `hope_obs` in `assert_source_tree`.
- No `*_OTEL_ENABLED` name is *required* for export in any service (each must export on endpoint
  presence alone).

Explain in the test's module docstring what each assertion protects, naming the finding id
(F-01…F-15). A parity test nobody understands gets deleted the first time it goes red.

**Gate:** `pnpm test:unit` filtered to this file, plus a deliberate RED proof — temporarily break
one service locally, show the test failing, revert, show it green. Paste both.

### 6.5 Lane D2 — env unification + Grafana wiring (Wave 3, `sonnet-5` / medium, other repo)

**Repo:** `hope-v2-deployment`. **Owns:** config maps, the Grafana datasource config, and the
collector allow-list.

1. Migrate every service to the R-2 contract: one `OTEL_EXPORTER_OTLP_ENDPOINT` per service,
   remove the `*_OTEL_ENABLED` literals D1 added, now that the services export on endpoint
   presence. Sequence matters — only do this after the corresponding service lane has merged AND
   been promoted; a half-migrated manifest turns telemetry off.
2. Add the Loki → Tempo derived field on `traceId` so a log line links to its trace (R-5).
3. Add `OTEL_TRACES_SAMPLER_ARG=1.0` to `overlays/dev` (explicit, so a future prod overlay has an
   obvious knob to lower).
4. Extend `redaction/phi`'s `allowed_keys` with any new `hope.*` attribute the service lanes
   reported, and only those.

**Gate:** `kustomize build deployment/k8s/overlays/dev` renders; each service's env block still
carries exactly one endpoint variable; paste the rendered env blocks.

### 6.6 Lane V — verification & review (Wave 3, `opus-5` / high, read-only)

**Owns:** nothing. Writes only §8 of this README, and only after the orchestrator asks.

Give this lane **distinct lenses**, not a repeat of the gates the other lanes already ran
(N identical reviewers only catch the failure mode all N share):

- **V-1 — did the standard actually land?** Read all six services and answer whether R-1..R-9 hold,
  per service, as a table. Treat a green suite as evidence of nothing: check the code.
- **V-2 — the open PHI question (F-10).** Determine empirically whether the collector's
  `redaction/phi` allow-list inspects OTLP **log bodies** or only attributes. If R-5 landed, the
  OTLP log path is gone and the question is moot — say so and close it. If any service still
  exports logs over OTLP, this is a **blocking** finding, not an observation.
- **V-3 — runtime proof, not compile proof.** With the dev stack up
  (`pnpm infra:dev:up:observability`, orchestrator-run), hit one endpoint per service and show:
  one JSON access line per request carrying `request_id` + `traceId`; the same trace id visible in
  Tempo; the worker's logs carrying a trace id. Paste the evidence.
- **V-4 — what did we break?** Diff the log-line shape before/after for each service and flag any
  Grafana dashboard or alert rule in `hope-v2-deployment` whose query depends on the OLD shape
  (label names, `job=` values, unparsed-text assumptions). This is the most likely silent breakage
  in the whole ticket and no other lane is looking for it.

---

## 7. Sequencing, gates and merge order

### Wave order

```
Wave 0   F (py-obs)            ║  D1 (turn telemetry on)      ← different repos, fully parallel
         └─ orchestrator: workspace member + uv lock + package.json + CI + turbo.json
Wave 1   A ║ B ║ C ║ E ║ G ║ H                                 ← six services, disjoint trees
Wave 2   P (parity gate)
Wave 3   D2 (env unification) ║ V (verification)
         └─ orchestrator: .claude/rules/06 + docs/operations/observability/python-*.md + F-14 fix
```

**Wave 0 must fully merge before Wave 1 is spawned.** Six lanes cannot each add a workspace member
and regenerate one `uv.lock`; that contention is exactly what `packages/py-otel/README.md` records
as the reason the module was once duplicated per service. Do not "save time" by overlapping them.

### Orchestrator steps between waves

| When | Action |
|---|---|
| After F merges | Add `packages/py-obs` to root `pyproject.toml` members; run `uv lock` **once from the primary checkout**; add the `py-obs:*` script block to `package.json` (mirror `py-otel:*`, lines 231-236); add `pip install --quiet --retries 5 --timeout 120 packages/py-obs` to all six Python jobs in `.gitlab/ci/test.yml`; add `OTEL_TRACES_SAMPLER_ARG` to `turbo.json#globalEnv`; run `pnpm setup:python` so `arcaenv` picks up the new editable install. THEN spawn Wave 1. |
| After each Wave-1 lane | Merge into `dev-2.2` from the PRIMARY checkout with `--no-ff`, re-run that service's gates **after** the merge (a clean merge is not a passing build), then remove the worktree. Never the reverse order. |
| After Wave 1 | Register the deprecation entries the lanes reported (shims + `*_OTEL_ENABLED`) in `docs/operations/deprecation-register.md`. |
| After Wave 2 | Run `pnpm lint:all` and the full Python suite set once, on the merged branch. |
| After Wave 3 | Land the rule update in `.claude/rules/06-python-services.md`, the standard at `docs/operations/observability/python-logging-and-tracing.md`, and the F-14 correction in `docs/operations/telemetry-phi-guardrails.md` §2 (deny-list → the deployed allow-list). |

### Merge discipline (`.claude/rules/14-multi-agent-worktrees.md` §5)

1. Confirm with the user that `dev-2.2` is still the active target before the first merge.
2. Finish the lane; its own gates green; nothing uncommitted.
3. Merge into `dev-2.2` **from the primary checkout**; resolve conflicts there; re-run the gates.
4. Only then `git worktree remove`. Never prune or force-remove a worktree with unmerged commits;
   an abandoned worktree is recoverable, a removed one is not.

### Ticket-level definition of done

- [ ] `packages/py-obs` exists, is a workspace member, and its suite/lint/typecheck/format are green
- [ ] All six services configure logging and tracing through `hope_obs` and define no local
      `structlog.configure` / `TracerProvider` / `_add_otel_context`
- [ ] All six expose `request_id` + `tenant_id` + `traceId` on access log lines
- [ ] `stt.worker` installs a real `TracerProvider`
- [ ] No service constructs an `OTLPLogExporter`
- [ ] Tracing is ON for all six in `hope-v2-dev`, verified by a rendered overlay and a live trace
- [ ] `tests/contracts/test_observability_parity.py` is green and has been seen RED
- [ ] `pnpm lint:all` green; every service's `test`/`lint`/`typecheck` green, output pasted in §8
- [ ] The standard is written to `docs/operations/observability/python-logging-and-tracing.md` and
      linked from `.claude/rules/06-python-services.md`
- [ ] F-14 corrected in `docs/operations/telemetry-phi-guardrails.md`
- [ ] §8 of this README records per-lane branch, merge commit, gates and evidence

### Out of scope (deliberately, with reasons)

| Item | Why not here |
|---|---|
| Alertmanager receivers / a paging path | Real gap, different problem — filling in one receiver block, not an instrumentation change |
| SLOs / new dashboards | Coverage of existing signals first; new measurement is a later ticket |
| WebSocket trace propagation (STT `/ws/stt/stream`, TTS `stream_ws`) | Cross-service context over WS is its own design; lane H reports it as a standing gap |
| The NestJS gateway's own logging | Different runtime, different rules (`05-nestjs-api.md`); the two meet only at the W3C wire format, which `hope_otel`'s three-way lock already pins |
| Prometheus metric taxonomy | R-9 keeps the existing rules; a metrics-naming pass is a separate ticket |

---

## 8. Implementation Summary

_Pending — filled in as lanes land. Per lane: branch, merge commit into `dev-2.2`, files changed,
gate commands with pasted output, and anything left unmerged (stated at the top, never buried)._

---

## 9. Change History

| Date | Change |
|---|---|
| 2026-09-18 | Ticket created. Review of all six Python services recorded as F-01…F-15; standard defined in §3; nine-lane multi-agent plan with disjoint ownership, model tiers and merge order defined in §5-§7. Status: Pending — awaiting approval to spawn Wave 0. |
| 2026-09-18 | Ticket committed to `dev-2.2` as `20526448a` so every worktree branches from a base that already contains it. **Wave 0 spawned.** Lane F (`opus-5`/high) in worktree `../hope-v2-t987-obs`, branch `task-987-py-obs`. Lane D1 (`sonnet-5`/medium) in `hope-v2-deployment`, branch `task-987-enable-otel` off `main`. Status: In Progress. |
