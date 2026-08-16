# TASK-725 Design Notes — Worker-Pool Topology + Task Envelope for `text`

Phase A deliverable (§4 Task 1). Reviewed against §1 scope boundaries before Phase B
started: does not touch the sync `/generate` or resumable-SSE (`stream.py`/`tasks.py`)
request *shape* (only adds a pre-dispatch health check inside `generate()`, §b below),
creates no `deployment/k8s/**` files in this repo, and does not migrate `apps/harness`'s
existing direct TEI-embed usage.

## (a) Pools subject to degrade-routing vs. GPU node-pool affinity

All nine registered `LLMProvider`s (`ollama`, `lm-studio`/`openai_compat`, `vllm`,
`llama-cpp`, `azure-openai`, `bedrock`, `openai`, `anthropic`, `vertex`) plus the new
`tei-embed` embedding provider are **pools** for degrade-routing purposes — a
rate-limited cloud provider degrades exactly like an unhealthy local one, per design.md.
Degrade-routing (§b) is provider-agnostic; it reads a health boolean, not a provider
type.

GPU node-pool affinity (a *deployment-repo* concern, not something this repo's control
plane enforces) applies only to the two engines that actually reserve a GPU device
locally (`docker-compose.dev.yml:484-490` — vLLM; llama.cpp is the CPU/GPU-flexible
peer typically co-scheduled with it): **vLLM and llama.cpp** should carry a
`nodeSelector`/`nodeAffinity` pinning them to a GPU node pool in
`arca/hope-v2-deployment`. Ollama, LM Studio (`openai_compat`), the five cloud
providers, and `tei-embed` (a CPU-served `BAAI/bge-m3` model per
`docker-compose.dev.yml:534-548`) do not need node-pool pinning. This is a **recommendation
for the deployment repo**, not something enforced from here (§6 risk: "this ticket
cannot verify node pools exist today").

## (b) Degrade-away-from-unhealthy routing — design

**Signal source:** `GET /health`'s existing per-provider `health_check()` loop
(`api/endpoints/health.py:62-75`) already calls every provider's `health_check()` and
sets the `PROVIDER_HEALTH` Prometheus gauge. Reading a `Gauge`'s internal `_value` back
from application code (as opposed to test assertions, where the codebase already does
this — `test_health_metrics.py:220`) is a private-API dependency and — more importantly
— the wrong layer: Prometheus metrics are a write-only observability channel, not a
control-flow store. Instead, `/health` now ALSO records the same boolean into a new
small in-process cache, `PoolHealthTracker` (`services/pool_health.py`) — the gauge and
the tracker are two views of the identical `health_check()` call, updated at the same
call site, so this adds no new probing.

**Fail-open on "unknown":** a provider nobody has health-checked yet (process just
started, or an operator never hit `/health`) is NOT treated as unhealthy — routing only
degrades away from a **positively known** unhealthy result. Requiring a preflight probe
on every `/generate` call would be an unrequested latency-profile change; the existing
`/health` cadence (liveness/readiness probes, manual polling) is the freshness bound.

**Dispatch-time check:** `generate()` (`api/endpoints/generate.py`) is the single
call site that resolves `provider = registry.get(request_body.provider)` for BOTH the
sync and the SSE-backed streaming path (the `if request_body.stream:` branch is AFTER
provider resolution) — so one check point covers both; `stream.py` itself only replays
already-produced chunks from Redis and initiates nothing, so it needs no change (the
ticket's file list named it conservatively; verified against the code that it does not
dispatch).

`services/pool_router.py::resolve_pool_route(provider, *, tracker, fallback,
fallback_registered)`:
- known-unhealthy + a caller-declared, registered `fallback` → returns the fallback
  provider name (request re-routes to it);
- known-unhealthy + no usable fallback → raises `PoolUnhealthyError` (mapped to 503,
  `Retry-After: 30` like `CircuitOpenError`) — **never** silently queues into the dead
  engine, per design.md;
- healthy or unknown → returns the original provider name unchanged (no behavior change
  for the overwhelming majority of requests, which name a provider nobody has flagged
  unhealthy).

`GenerateRequest` gains one additive, optional field: `fallback_provider: str | None =
None` (same pattern as the existing additive `content_parts` field) — the caller
(gateway/harness) opts a request into fallback; omitting it preserves today's
fail-fast-on-unhealthy behavior (now a typed 503 instead of an eventual provider-call
failure).

## (c) Queue-depth metric definition + label set (for Task 5 / KEDA)

New Gauge, named consistently with every OTHER metric already in
`core/metrics.py` — all of which are still `smr_*`-prefixed today (TASK-707 renamed
the package/directory/env-vars to `text`, but did not touch Prometheus metric name
strings — confirmed by inspection: `SERVICE_NAME = "smr"` and every existing metric name
in `metrics.py` is still literally `smr_*` post-707). Landing a lone `text_*` metric
next to fifteen `smr_*` ones would be the exact drift this ticket's own §3 pitfall
warns about, just in the other direction — so new metrics in this ticket ALSO carry the
`smr_` prefix, matching the current tree. Renaming the whole existing metric surface is
out of this ticket's scope (§1 — only additive work).

```python
WORKER_POOL_QUEUE_DEPTH = Gauge(
    "smr_worker_pool_queue_depth",
    "Pending async worker-pool tasks per pool (queue depth for KEDA's Prometheus scaler)",
    ["task_type"],          # "embedding" | "batch_generation"
)
WORKER_POOL_TASKS_TOTAL = Counter(
    "smr_worker_pool_tasks_total",
    "Async worker-pool tasks submitted, by pool and outcome",
    ["task_type", "status"],  # status: submitted | completed | failed
)
```

`task_type` is the label KEDA's `ScaledObject` (deployment repo) would key its
`triggers[].metadata.query` on — e.g. `smr_worker_pool_queue_depth{task_type="embedding"}`
for the batch-embedding worker Deployment's `ScaledObject`, and the equivalent
`{task_type="batch_generation"}` series for the batch-generation worker Deployment's.
Realtime HPA custom-metrics would instead read the existing per-provider
`smr_active_generations`/`model_inference_latency_seconds` (sync path, untouched by this
ticket) — queue depth is a BATCH-path signal only, by design (a realtime/sync request has
no queue to measure).

## (d) Task envelope — worker-pool queue design

**Transport:** Redis Streams with a consumer group per `task_type`, mirroring
`TaskManager`'s existing Redis-Streams usage (`services/task_manager.py`) rather than
introducing a new broker (D7 — contract-over-broker; reuse existing infra). Key prefix
`smr:workerpool:{task_type}` (same `smr:` prefix TaskManager/idempotency-cache keys
already use — see (c) above for why the prefix is not yet `text:`).

**New construct, deliberately NOT named `ProviderQueue`:** `services/worker_pool_queue.py`
defines `WorkerPoolQueue` — cross-process/cross-pod dispatch to a SEPARATE worker
consumer (this ticket's Task 7 entry point, run as its own `pnpm text:worker:dev`
process / future k8s Deployment). This is unrelated to the existing in-process
`services/provider_queue.py::ProviderQueue` (an `asyncio.PriorityQueue` used only for
same-pod backpressure) — see §3's named pitfall. Both may exist in the same request
lifecycle without being confused: `ProviderQueue` throttles a SYNC `/generate` call
inside its own pod; `WorkerPoolQueue` is the async, cross-pod dispatch mechanism this
ticket adds.

**Envelope schema** (`models/worker_task.py::WorkerTaskEnvelope`), modeled on
`apps/stt/src/stt/transcription/workers/transcribe_file.py:31-51`'s Dramatiq actor
kwarg shape, scoped to batch generation + embedding ONLY (never the sync/SSE paths):

| Field | Type | Notes |
|---|---|---|
| `task_id` | `str` | UUID; the SAME id `TaskManager.create_task()` returns — task STATE stays TaskManager's job (`task_manager.py` is extended, not replaced, per §3); the envelope only carries DISPATCH data. |
| `task_type` | `"embedding" \| "batch_generation"` | discriminator; selects the stream/consumer-group and the worker-side handler. |
| `tenant_id` | `str \| None` | correlation only (control plane stays stateless — no per-tenant DB read here). |
| `request_id` | `str \| None` | cross-service trace correlation, same convention as `GenerationAuditEvent.request_id`. |
| `priority` | `int` | informational for now (single-priority stream); reserved so a future priority-queue split doesn't need a schema migration. |
| `idempotency_key` | `str \| None` | mirrors `/generate`'s existing `Idempotency-Key` header convention — a worker-crash re-delivery (Redis Streams consumer-group semantics are at-least-once) must not re-bill/re-run. Handlers MUST check this before doing paid work. |
| `max_retries` | `int` | default 3, mirrors `transcribe_file.py`'s `max_retries=3`. |
| `payload` | `dict[str, Any]` | task-type-specific body (e.g. `{"texts": [...], "provider": "tei-embed", "model": "..."}` for embedding). |
| `created_at` | `datetime` | for queue-wait-time observability. |

**Submission fails closed during drain:** `WorkerPoolQueue.submit()` takes the
`ShutdownManager` and raises `ShutdownError` (503, reused — not a new exception type)
when `is_shutting_down` is set, mirroring `generate()`'s existing check. This is the
"stop accepting new async tasks" half of Task 6's drain contract; the "let the in-flight
one finish" half is the WORKER process's own responsibility (§Task 7 — a separate pod
per design.md, so the API pod's shutdown cannot itself drain a worker it doesn't
manage).

## (e) Reconciliation with TASK-717 (not yet authored)

TASK-717 (`async-contract`) does not exist yet (§2.8) and is design.md's own open
question #3 ("Async contract envelope details... needs its own short design"). This
envelope is scoped narrowly (batch generation + embedding, Redis Streams, this repo
only) specifically so TASK-717's eventual author has a small, real, working exemplar to
reconcile against rather than an unauthored abstraction to build from scratch — but it
IS a second, independently-designed envelope shape next to whatever TASK-717 lands.
Flagged in the PR description per §6: TASK-717's author should treat
`WorkerTaskEnvelope` as a candidate input, not a frozen contract.
