# TASK-725 — Worker Pool: `text` (ex-`smr`) Control Plane + Engine Worker Pools

| | |
|---|---|
| **Status** | Review |
| **Wave** | 3 · **Size** | L |
| **Epic slug** | `worker-pool-text` |
| **Depends on** | TASK-707 (`naming-alignment` — `smr` → `text` rename; this ticket is written and MUST be executed against the renamed tree) |
| **Design refs** | [design.md](../../programs/agentic-workflow-platform/design.md) §Services program ("Worker-pool standard"), D7 (async transport), D8 (naming) |
| **Findings closed** | — (infrastructure-scaling ticket; does not close a numbered assessment finding) |

## 1. Requirement Analysis

Turn `apps/text` (post-TASK-707: `apps/text`, package `text`) into the **control plane** for
text-generation and text-embedding, per the design's worker-pool standard: *"the service is the
control plane — registry, health, routing, backpressure; workers are separate k8s Deployments per
engine; KEDA on queue depth for batch, HPA on custom latency/utilization metrics for realtime; GPU
engines pin node pools; the service degrades routing away from unhealthy pools rather than queueing
into a dead engine. Workers are never process-managed inside the service pod."* (design.md
§Services program).

Concretely, this ticket delivers, for the renamed `text` service:

1. A **worker/pool health & introspection contract** — the control plane already routes to and
   health-checks named providers (§2 below); this ticket adds admin-visible per-pool status,
   degrade-away-from-unhealthy routing, and the metrics KEDA/HPA need, without which no
   autoscaler configuration (however it's expressed downstream) has anything correct to read.
2. A **worker task envelope** for genuinely asynchronous work (batch generation jobs and the new
   text-embedding task type) — distinct from the synchronous request/response and resumable-SSE
   paths that already exist and are NOT in scope to change.
3. A **text-embedding task type** — net new; `text` has no embedding capability today.
4. The **k8s/KEDA/HPA manifest work**, explicitly flagged as landing in the separate
   `arca/hope-v2-deployment` repo (`.claude/rules/09-infrastructure-devops.md` §Cluster Deploys —
   "The manifests are NOT in this repo"), with acceptance criteria this ticket can still verify
   from *this* repo: the metrics exist and are scraped, the contract is tested, and drain behavior
   is proven in a unit/integration test — not by inspecting a manifest we cannot see.

**Explicitly OUT of scope:**
- Migrating `apps/harness`'s existing direct TEI-embed calls (`apps/harness/src/harness/core/config.py`)
  to route through `text`'s new embedding endpoint. That is a real follow-up (harness currently
  talks to `tei-embed` directly for RAG) but is a separate blast radius — flagged as an open
  question (§6), not built here.
- Any change to the synchronous generation (`POST /generate`) or resumable-SSE (`stream.py`,
  `tasks.py`) request paths — those already work and are reused as-is.
- The actual KEDA `ScaledObject` / HPA `HorizontalPodAutoscaler` YAML — written in
  `arca/hope-v2-deployment`, not this repo (§4 Phase C tasks are scoped to be handed off cleanly).
- Renaming `smr` → `text` itself (TASK-707's job — this ticket depends on it landing first).

## 2. Current State Evaluation

**Verified 2026-08-16 against `apps/text/src/text/` (pre-707 tree; TASK-707 renames the package to
`text` without changing structure — every relative path below carries over 1:1 under `apps/text/src/text/`).**

### 2.1 Provider/engine registry — already exists, in-process only

- `ProviderRegistry` (`apps/text/src/text/providers/base.py:89-133`) is a lazy, factory-based
  registry: `register_factory(name, factory)` (`:108`) defers instantiation to first `get(name)`
  (`:112-120`), memoizes the instance, and raises `ProviderNotFoundError` (`:15`) on an unknown or
  unconfigured name — already "fails closed," not silently substituting a provider.
- Nine `LLMProvider` implementations exist under `apps/text/src/text/providers/`: `ollama.py`,
  `openai_compat.py` (LM Studio target), `vllm.py`, `llama_cpp.py` (local/GPU engines) and
  `azure_openai.py`, `bedrock.py`, `openai.py`, `anthropic.py`, `vertex.py` (BYOK cloud).
  `apps/text/src/text/providers/base.py:19-56` (`require_model`, `reject_vision`) documents the
  fail-closed model-selection contract cloud providers must honor per
  `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers `failMode=closed`.
- Registration happens once at startup in `apps/text/src/text/main.py:59` (loop registering
  factories) and `:165-170` (lazy `app.state.provider_registry` construction). `Depends` accessors:
  `get_provider_registry` (`apps/text/src/text/core/dependencies.py:42`).

**What this ticket REUSES as-is:** `ProviderRegistry`, all nine provider implementations, the
fail-closed model-selection guards. This ticket does NOT rewrite provider routing — it wraps it
with health-based degrade-routing and exposes it for autoscaling.

### 2.2 No out-of-process worker exists today — everything runs in the request pod

This is the single most important current-state fact for this ticket: **`apps/text` has no worker
process, no Dramatiq/Celery/BullMQ, and no queue-consumer today.** Verified by:

- `grep -rl "dramatiq\|celery" apps/text/src` — zero hits.
- `apps/text/src/text/services/provider_queue.py:1-44` — `ProviderQueue` is an **in-process**
  `asyncio.PriorityQueue` used only for backpressure inside the same FastAPI worker process that
  received the HTTP request (`:23-27`); it is not a cross-process/cross-pod dispatch mechanism.
- `apps/text/src/text/services/task_manager.py:1-45` — `TaskManager` is **Redis-backed task STATE**
  (`smr:task:` / `smr:stream:` key prefixes, `:18-19`) that makes a long-running generation
  resumable/pollable across HTTP reconnects (`apps/text/src/text/api/endpoints/tasks.py:1-34`,
  `stream.py`). The generation itself still executes on the SAME pod/process that accepted the
  original request — this is resumability, not out-of-process work dispatch.
- Root `package.json`: `text:dev`/`text:dev:watch`/`text:test*`/`text:lint`/`text:typecheck`/`text:format*`
  exist (lines 129-145); there is **no `text:worker:dev`** (contrast `apps/stt`, which has one — see
  TASK-726). Confirms: no worker entry point exists to invoke today.
- `infrastructure/docker/docker-compose.dev.yml` — no `smr:` (nor `text:`) service block exists at
  all. Like all six Python services, `apps/text` runs natively via conda (`pnpm text:dev` →
  `scripts/dev-service.sh smr`), never as a compose service; only its infra dependencies (Postgres,
  Redis, Vault) and optional inference backends run in compose.

**What IS already out-of-process, but not "SMR's workers":** `vllm` (`:448-496`), `llama-cpp`
(`:497-533`), and `tei-embed` (`:534-...`) are separate Docker Compose services under the
`inference` profile (`infrastructure/docker/docker-compose.dev.yml:451,500,537`). `vllm` reserves a
GPU device today (`:484-490`: `deploy.resources.reservations.devices` with `driver: nvidia`,
`capabilities: ["gpu"]`). These are HTTP backends `text`'s providers call — SMR does not manage
their process lifecycle, and today it has no health-driven routing decision beyond "is this
provider registered."

### 2.3 Health — per-provider check exists; no degrade-routing decision consumes it yet

`GET /health` (`apps/text/src/text/api/endpoints/health.py:49-79`) iterates
`registry.list_providers()` (`:64`), calls each provider's `health_check()` (`:67`), and sets the
`PROVIDER_HEALTH` gauge (`:68` / metrics.py — see §2.5). This is the correct primitive to build
degrade-routing on, but **nothing today reads `PROVIDER_HEALTH` to change generation routing** — a
request for an unhealthy provider still gets dispatched to it and fails at call time. That gap is
Phase B's job (§4).

### 2.4 SSE/streaming — reused unchanged

`apps/text/src/text/api/endpoints/stream.py` + `TaskManager`'s Redis Stream chunk persistence
(`task_manager.py`) already implement resumable SSE with a Redis message id per event, per
`.claude/rules/06-python-services.md` §Gateway Integration & Auth. Not touched by this ticket.

### 2.5 Metrics — generation metrics exist; no queue-depth / pool-health metric exists

`apps/text/src/text/core/metrics.py:11-59` defines `smr_generation_total`, `smr_generation_latency_seconds`,
`smr_tokens_total`, `smr_generation_errors_total`, `smr_active_generations` (Gauge, per-provider),
`smr_provider_health` (Gauge, `:42-46`), `smr_health_check_latency_seconds`,
`smr_time_to_first_token_seconds`. **No queue-depth gauge and no per-worker-pool saturation metric
exists** — both are net new (Phase B). `infrastructure/docker/configs/prometheus/prometheus.yml`
already scrapes `smr` (rename to `text` is TASK-707's job, not this ticket's) — confirm the job name
after 707 lands; do not assume it is still `smr` at execution time.

### 2.6 Config — per-engine env prefixes exist; no per-tenant engine enable/disable

`apps/text/src/text/core/config.py`: `OllamaConfig` (`:44-50`, `env_prefix="TEXT_OLLAMA_"`),
`AzureOpenAIConfig` (`:67-73`), `BedrockConfig` (`:105-111`), `OpenAICompatConfig` (`:127-133`),
`VllmConfig` (`:153-162`, extends `OpenAICompatConfig`), `LlamaCppConfig` (`:177-188`),
`OpenAIConfig`/`AnthropicConfig`/`VertexConfig` (`:197-277`), `QueueConfig`
(`:431-437`, `env_prefix="TEXT_QUEUE_"` — this is the existing in-process `ProviderQueue`'s sizing
config, not a new worker-pool concept). All per-engine connection config is env-tier
(`.claude/rules/09-infrastructure-devops.md` §Configuration Tiers) — consistent with "connection
identity" belonging in env, not DB. Provider/model SELECTION is `failMode=closed`
(`providers/base.py:19-38`); tuning knobs fail open — same split this ticket's new health/degrade
logic must preserve (do not turn a tuning failure into a hard 503; do turn an unresolved
provider/model selection into one).

### 2.7 Embeddings — genuinely net new; `text` has none, `harness` calls `tei-embed` directly

`grep -rn "embedding" apps/text/src --include="*.py"` returns **zero hits**. `tei-embed` (compose
service, `infrastructure/docker/docker-compose.dev.yml:534-...`, port 8870 per
`.claude/rules/00-project-context.md`) is consumed today **only** by `apps/harness`
(`apps/harness/src/harness/core/config.py`, `apps/harness/src/harness/tests/unit/core/test_llm_concurrency.py`,
`apps/api/tests/e2e/harness-institutional-rag.spec.ts`) for its RAG pipeline — SMR/`text` has no
embedding provider, endpoint, or model today. This ticket adds the embedding task TYPE and provider
path to `text`; it does NOT migrate harness's existing direct TEI-embed usage (§1 out-of-scope,
§6 open question).

### 2.8 Async contract — TASK-717 does not exist yet; this ticket must not block on it

`docs/implementation/` contains no `TASK-717-*` folder (checked directly — the folder is empty
except historical `.DS_Store`) and `docs/archive/` new-sprint ids (700+) are likewise not yet
populated beyond what's already visible in this program. Per backlog.md, TASK-717
(`async-contract`) is a **T4 design ticket, not yet authored**, and design.md's own open question
#3 confirms: *"Async contract envelope details (schema, delivery semantics, resume tokens) — needs
its own short design."* This ticket therefore specifies its OWN worker task envelope (§3, §4 Phase A)
sufficient to build against today, explicitly flagged for reconciliation once TASK-717 lands
(§6 Risks & Open Questions) — it must not invent a competing standard that TASK-717 then has to
migrate away from without cause.

**Closest existing envelope to imitate**, per the ticket-template rule to name a real exemplar: the
Dramatiq batch actor in `apps/stt/src/stt/transcription/workers/transcribe_file.py:31-51`
(`@dramatiq.actor(queue_name="stt_batch", max_retries=3, min_backoff=10000, max_backoff=300000,
time_limit=...)`, plain-kwarg envelope: `job_id, tenant_id, pipeline_id, ...`). It is the only
out-of-process worker task envelope actually running in this monorepo today.

## 3. Knowledge & Best Practices

- `.claude/rules/06-python-services.md` — conda `arcaenv` + uv workspace (`uv lock` at root after
  any `pyproject.toml` dependency change); `env_prefix` discipline (§Config); the default
  gateway-resolved-injection pattern for per-tenant config (TTS is the exemplar —
  `packages/database/src/prisma/db_main/tenant-tts-config.prisma:4-6` explicitly documents
  "the STATELESS apps/tts service... never touches Postgres" — `text` should follow the same
  posture for any new per-tenant embedding/engine-enablement config, not open its own DB connection);
  `X-Service-Token` auth on new internal endpoints; Prometheus `/metrics` + `structlog` dotted event
  names for anything new.
- `.claude/rules/09-infrastructure-devops.md` §Cluster Deploys — the k3s manifests live in
  `arca/hope-v2-deployment`, a **separate** repo; nothing in this ticket may create
  `deployment/k8s/**` files in *this* repo (that tree was deleted 2026-07-24, `deployment/README.md`
  explains why — do not recreate it). §Configuration Tiers governs where any new
  per-engine-enablement setting lives (a kill-switch belongs in `redis-flag`, tuning in `db-config`
  or env, never a plaintext credential in a DB column). §Dockerfiles & Images — no `latest` tags if
  a new worker image is proposed downstream.
- design.md §Services program (worker-pool standard, quoted in full in §1) is the load-bearing
  spec for this ticket; D7 (contract-over-broker) governs the task envelope choice — reuse existing
  infra (Redis Streams / the pattern in `apps/stt`'s Dramatiq setup), do not introduce a new broker.
- Known pitfall: `ProviderQueue` (in-process `asyncio.PriorityQueue`,
  `apps/text/src/text/services/provider_queue.py`) and the new out-of-process worker queue this ticket
  adds are DIFFERENT things with confusingly similar names — do not conflate "buffering inside one
  pod" with "dispatching to a separate worker pool." Naming the new construct distinctly (e.g.
  `WorkerPoolQueue` / `AsyncTaskQueue`, not `ProviderQueue`) is a hygiene requirement, not a nitpick,
  given TASK-707 is simultaneously renaming things.
- Known pitfall: `smr_*` metric name prefixes will collide with `text_*` if TASK-707 renames the
  service but this ticket's PR predates that rename landing — sequence Phase B work strictly after
  TASK-707 merges (§Depends on), and if executed before 707 merges for any reason, land metric names
  as `smr_*` and let 707's mechanical rename touch them, never hand-invent `text_*` names against a
  tree that still says `smr` everywhere else.
- TDD ordering: every new endpoint/metric/behavior gets a failing test first (`.claude/rules/01-development-workflow.md`
  §TDD Requirements) — test locations under `apps/text/src/text/tests/unit/` (root `package.json:135-139`
  confirms `text:test:unit` targets `apps/text/src/text/tests/unit/`).

## 4. Implementation Plan

### Phase A — Pool topology + worker protocol design

#### Task 1 — Design the worker-pool topology and task envelope for `text`
- **Agent:** T4 · opus-4-8 · high
- **Files:** `docs/implementation/TASK-725-Worker-Pool-Text/design-notes.md` (new, this ticket's
  own design artifact — do not skip straight to code)
- **Approach:** Produce a short design covering: (a) which providers are "pools" subject to
  degrade-routing (all nine, cloud and local alike — a rate-limited cloud provider degrades exactly
  like an unhealthy local one) vs. which need GPU node-pool affinity (vLLM, llama.cpp — pin to a
  GPU node pool in the deployment repo; Ollama/LM Studio/cloud do not); (b) the async task envelope
  schema (task type discriminator, tenant/request correlation ids, priority, idempotency key,
  retry policy) modeled on `apps/stt/src/stt/transcription/workers/transcribe_file.py:31-51`'s
  Dramatiq actor signature, explicitly scoped to batch generation + the new embedding task type
  only (NOT the existing sync/SSE paths); (c) the queue-depth metric definition and label set
  needed for KEDA (§Task 5); (d) explicitly note where this will need to reconcile with TASK-717
  once authored (§6). Cite `apps/text/src/text/providers/base.py:89-133` and
  `apps/text/src/text/services/task_manager.py` as the registry/task-state exemplars being extended,
  not replaced.
- **Verify:** Design note reviewed against §1 scope boundaries (does not touch sync/SSE paths, does
  not create `deployment/k8s/**` in this repo, does not migrate harness's TEI-embed usage).

### Phase B — Control plane: health-driven degrade routing, admin introspection, embeddings

#### Task 2 — Degrade-away-from-unhealthy routing
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `apps/text/src/text/providers/base.py` (or a new `apps/text/src/text/services/pool_router.py`
  per Task 1's design), `apps/text/src/text/api/endpoints/generate.py`, `apps/text/src/text/api/endpoints/stream.py`
- **Approach:** Failing test first (`apps/text/src/text/tests/unit/`): a request routed to a provider
  whose last `health_check()` (via the existing `PROVIDER_HEALTH` gauge state,
  `apps/text/src/text/api/endpoints/health.py:64-68`) is unhealthy must either (a) route to a
  configured fallback provider if the request declares one is acceptable, or (b) fail fast with a
  typed error distinguishing "unhealthy pool" from `ProviderNotFoundError` — never silently queue
  into a dead engine (design.md §Services program). Wire this as a check consulted before dispatch
  in `generate.py`/`stream.py`, reusing `ProviderRegistry.get()` unchanged.
- **Verify:** `pnpm text:test:unit` — new tests pass; existing generation tests unaffected.

#### Task 3 — Admin introspection endpoint (per-engine pool status)
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/text/src/text/api/endpoints/providers.py` (extend — this file already exists and
  is the natural home; verify its current contents before extending, do not assume it's empty),
  new response model in `apps/text/src/text/models/provider.py`
- **Approach:** Add a field to the existing providers-listing response (or a new endpoint if
  `providers.py`'s current shape doesn't fit) exposing, per registered provider: health status,
  last-check timestamp, in-flight-request count (from `smr_active_generations`), and (once Task 5
  lands) queue depth for async-capable providers. This is what a k8s liveness/readiness probe
  AND a human operator both read — keep the shape stable since KEDA/HPA manifests in the
  deployment repo may poll it via Prometheus rather than this endpoint directly, but an admin
  console screen (out of scope here) will want this shape later.
- **Verify:** `pnpm text:test:unit`; manual `curl localhost:8862/api/v1/providers` (or renamed port
  per TASK-707) returns the new fields.

#### Task 4 — Text-embedding task type
- **Agent:** T3 · sonnet-5 · medium
- **Files:** new `apps/text/src/text/api/endpoints/embeddings.py`, new
  `apps/text/src/text/providers/tei_embed.py` (or extend `openai_compat.py` if TEI's wire protocol
  is OpenAI-embeddings-compatible — verify against `tei-embed`'s actual API before choosing), new
  entries in `apps/text/src/text/core/config.py` (new `TeiEmbedConfig`, `env_prefix="TEXT_TEI_"` or
  `TEXT_TEI_` post-rename — follow whatever TASK-707 lands as the service's env prefix), registered
  in `ProviderRegistry` alongside the nine generation providers (a SEPARATE registry namespace or a
  `task_type` field disambiguating generation vs. embedding providers — decide in Task 1's design,
  since `ProviderRegistry.get(name)` today has no task-type dimension).
- **Approach:** Failing test first. New endpoint follows the same fail-closed model-selection
  contract as generation (`require_model`, `apps/text/src/text/providers/base.py:19-38`) for any
  cloud embedding provider added later; local `tei-embed` keeps its topology-level default per the
  existing local-engine convention (`base.py:26-28`).
- **Verify:** `pnpm text:test:unit`; `pnpm text:typecheck`.

#### Task 5 — Queue-depth and pool-saturation metrics
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/text/src/text/core/metrics.py` (extend), Task 2/4's new code paths
- **Approach:** Add a `Gauge` for async-task queue depth per provider/pool (naming per Task 1's
  design note; do not extend `smr_active_generations`, which measures sync in-flight requests, not
  queued async tasks) and a saturation ratio if the design calls for one. This is the metric KEDA's
  `ScaledObject` (deployment repo) will read via the Prometheus scaler, and the metric HPA's
  custom-metrics adapter reads for realtime — both consume Prometheus, neither is built in this
  repo, but the metric must exist and be scraped for either to work.
- **Verify:** `pnpm text:test:unit`; `curl localhost:8862/metrics | grep <new_metric_name>` shows the
  gauge registered.

#### Task 6 — Drain behavior on shutdown
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/text/src/text/main.py` (lifespan shutdown), `apps/text/src/text/services/shutdown_manager.py`
  (already exists — verify its current scope before extending; it may already cover in-flight
  sync requests, in which case this task extends it to the new async task queue rather than
  building shutdown handling from scratch)
- **Approach:** On SIGTERM, the control plane must stop accepting new async tasks onto the Task 4/5
  queue, let in-flight ones finish or requeue, and report "draining" via Task 3's introspection
  endpoint so a k8s `preStop` hook (deployment repo) can poll it — mirrors
  `TemporalConfig.graceful_shutdown_timeout_s` (`apps/harness/src/harness/core/config.py:43-46`) as
  the pattern precedent for a bounded drain window, though that is Temporal-specific machinery, not
  directly reusable code.
- **Verify:** `pnpm text:test:unit` — a test asserting a SIGTERM mid-drain rejects new task
  submissions while letting an in-flight one complete.

### Phase C — Local-dev story + deployment-repo handoff (flagged)

#### Task 7 — Local-dev worker-pool story
- **Agent:** T2 · sonnet-5 · low
- **Files:** `package.json` (new `text:worker:dev` script — or `text:worker:dev` if run after 707 —
  mirroring `stt:worker:dev` at `package.json:116`), `scripts/dev-service.sh` (extend the existing
  dispatch, do not fork a new script)
- **Approach:** There is no compose profile per Python service today (§2.2) — the correct local-dev
  story is a root script launching the new async worker consumer process natively via conda, the
  same way `stt:worker:dev` does, NOT a new Docker Compose service. Confirm this against
  `scripts/dev-service.sh`'s existing `stt-worker` case before adding a parallel `smr-worker`/`text-worker`
  case.
- **Verify:** `pnpm text:worker:dev` (or renamed) starts the worker process against local Redis;
  manual smoke test — submit an async embedding task, confirm the worker processes it.

#### Task 8 — [FLAGGED: lands in `arca/hope-v2-deployment`] KEDA ScaledObject + HPA manifests
- **Agent:** T4 · opus-4-8 · medium (k8s/KEDA design) — executed against the deployment repo, not
  this one
- **Files:** none in this repo. Deliverable: a design note (in this ticket's Implementation Summary,
  §7) specifying the `ScaledObject` (queue-depth trigger reading Task 5's metric via the Prometheus
  scaler) and `HorizontalPodAutoscaler` (custom-metrics trigger reading the realtime latency/session
  metric) that the deployment repo's maintainer applies — this repo has no visibility into whether
  KEDA is even installed on the cluster (unverifiable from here; §6).
- **Verify (from THIS repo):** Task 5's metric is scraped by Prometheus
  (`infrastructure/docker/configs/prometheus/prometheus.yml` — confirm the job name after TASK-707's
  rename); a contract test proves the metric's label set matches what the design note promises the
  KEDA trigger will query; Task 6's drain behavior is proven by a unit test (not by inspecting a
  `preStop` hook that lives in a repo we can't read).

## 5. Acceptance Criteria

- [ ] `pnpm text:test` (or `pnpm text:test` if executed after TASK-707) — all new and existing tests
      pass; paste output.
- [ ] `pnpm text:lint` / `pnpm text:typecheck` — clean; paste output.
- [ ] `uv lock` re-run at repo root if any `apps/text/pyproject.toml` dependency changed (new TEI
      client, etc.) — per `.claude/rules/06-python-services.md`.
- [ ] Degrade-routing (Task 2): a test proves a request never dispatches to a provider the health
      check has marked unhealthy without an explicit fallback.
- [ ] Admin introspection endpoint (Task 3) returns per-provider health + in-flight/queue-depth
      fields — manual `curl` output pasted.
- [ ] Text-embedding endpoint (Task 4) round-trips against `tei-embed` in local dev — manual test
      output pasted.
- [ ] Queue-depth metric (Task 5) visible in `/metrics` output — pasted.
- [ ] Drain behavior (Task 6) covered by a test that sends SIGTERM mid-queue and asserts no new
      task is accepted while the in-flight one completes.
- [ ] Local worker entry point (Task 7) starts via a root `pnpm` script and processes a submitted
      async task in local dev — manual output pasted.
- [ ] Task 8's design note is written into §7 below, explicitly scoped as deployment-repo work with
      no `deployment/k8s/**` files created in THIS repo.
- [ ] No new `databaseService.client`/direct-Prisma access introduced (this is a Python service —
      confirm no accidental Postgres connection was added to what must stay a stateless control
      plane, per §3).

## 6. Risks & Open Questions

- **HUMAN-GATED-adjacent, not fully gated:** TASK-717 (`async-contract`) does not exist yet
  (§2.8). This ticket ships its own envelope to avoid blocking on an unauthored design ticket, but
  that envelope may need to change once TASK-717 lands — flag this explicitly in the PR description
  so TASK-717's author reconciles rather than silently diverges. Not HUMAN-GATED in the sense of
  needing a stakeholder decision before starting, but the eventual reconciliation is a known,
  named risk.
- **Open question:** should `apps/harness`'s existing direct `tei-embed` calls migrate to route
  through `text`'s new embedding endpoint (consistent with design.md naming `text` as *the*
  control-plane proxy for embeddings), or is a direct-to-TEI RAG path intentionally kept separate
  for latency reasons? Not decided here — flagged for the design.md maintainers. **Answer**: We need a central point for all text generation and embedding tasks, so we should route through `text`'s new embedding endpoint.
- **Unverifiable from this repo:** whether KEDA is installed on the cluster at all, and what
  Prometheus-adapter configuration (if any) already exists for HPA custom metrics. `arca/hope-v2-deployment`
  is a separate repo this session cannot read. Task 8 is scoped so its acceptance criteria only
  claim what's provable from here.
- **Risk:** adding GPU node-pool pinning intent (vLLM/llama.cpp) has zero effect until the
  deployment repo actually defines separate node pools — this ticket cannot verify that node pools
  exist today; it can only make the control plane ready to route to them once they do.
- **Risk:** TASK-707's rename could land mid-execution of this ticket. Sequencing (§Depends on)
  exists precisely to avoid this, but if violated, expect `smr_*`/`text_*` metric-name churn (§3
  pitfall) as the concrete failure mode.

## 7. Implementation Summary

Executed against the committed post-TASK-707 tree (`apps/text`, `TEXT_*` env vars,
package `text`). Local infra (Postgres/Redis/API/Temporal) was DOWN for the whole
session — no cluster access either — so everything below was verified with hermetic
unit tests (mocked Redis/httpx, ASGI test client) rather than live services; every item
that genuinely needs live infra is called out as gated, not claimed as done.

### Phase A — design (Task 1)

`docs/implementation/TASK-725-Worker-Pool-Text/design-notes.md` — pool topology
(all 10 providers incl. `tei-embed` are degrade-routing pools; vLLM/llama.cpp are the
GPU-node-pool-affinity candidates for the deployment repo), the `WorkerTaskEnvelope`
schema, the queue-depth metric label set, and the TASK-717 reconciliation note.
Reviewed against §1's scope boundaries before Phase B started.

### Phase B — control plane (Tasks 2–6)

- **Task 2 (degrade-routing):** `services/pool_health.py` (`PoolHealthTracker` — a
  small in-process cache populated by `GET /health`'s existing per-provider
  `health_check()` loop, the SAME call site that already sets `PROVIDER_HEALTH`;
  deliberately NOT reading the Prometheus gauge back from app code — see
  design-notes.md §(b) for why) + `services/pool_router.py`
  (`resolve_pool_route`) + `core/exceptions.PoolUnhealthyError` (503,
  `Retry-After: 30`, mapped in `core/exception_handlers.py`) + an additive
  `GenerateRequest.fallback_provider` field. Wired into `generate.py` as a single
  check before dispatch that rewrites `request_body.provider` in place, so every
  downstream provider-keyed lookup (rate limiter, circuit breaker, queue,
  semaphore, metrics, audit, task state) naturally reflects the ACTUAL serving
  provider. `stream.py` needed no change — verified it only replays already-produced
  chunks and never dispatches (the ticket's file list named it conservatively).
- **Task 3 (admin introspection):** `GET /providers` (`api/endpoints/providers.py`)
  gained `pool_health` / `pool_health_checked_at` / `in_flight_requests` per entry
  (additive fields on `models/provider.ProviderInfo`), sourced from the SAME
  `PoolHealthTracker` and the existing `ACTIVE_GENERATIONS` gauge. A new
  `GET /worker-pools` endpoint (`api/endpoints/worker_pools.py`,
  `models/worker_pool_status.WorkerPoolStatus`) reports per-`task_type` queue depth
  + `draining` — kept as its OWN endpoint rather than folded into `/providers`
  because the shapes differ (per-pool vs. per-provider) and `/providers`' `list[ProviderInfo]`
  shape is a real external contract (the gateway discovery merge keys on it per
  the file's own docstring).
- **Task 4 (text-embedding):** net new. `core/config.TeiEmbedConfig`
  (`TEXT_TEI_*`, default `base_url=http://localhost:8871` matching
  `docker-compose.dev.yml`'s `HOPE_TEI_EMBED_PORT`), `providers/embedding.py`
  (`EmbeddingProvider` protocol + `EmbeddingProviderRegistry` — a SEPARATE
  registry namespace, mirroring `TranslateProviderRegistry`'s established
  precedent for a structurally-different capability), `providers/tei_embed.py`
  (`TeiEmbedProvider`, targeting TEI's native `POST /embed` — chosen over the
  OpenAI-compatible `/v1/embeddings` route TEI only added in 1.2+, unverifiable
  which build the compose image tag resolves to without live infra),
  `models/embedding.py` (`EmbeddingRequest`/`EmbeddingResponse`/
  `EmbeddingBatchRequest`/`EmbeddingBatchAcceptedResponse`),
  `api/endpoints/embeddings.py` (`POST /embeddings` synchronous round trip;
  `POST /embeddings/batch` async submission returning 202 + a `task_id` pollable
  via the EXISTING `GET /tasks/{task_id}` — no duplicate status route). Registered
  unconditionally in `main.py`'s lifespan (always-available local-engine convention,
  same as Ollama/LM Studio).
- **Task 5 (queue-depth metrics):** `core/metrics.py` gained
  `smr_worker_pool_queue_depth{task_type}` (Gauge) and
  `smr_worker_pool_tasks_total{task_type,status}` (Counter) — still `smr_`-prefixed
  like every OTHER metric in the file; TASK-707 renamed the package/env vars but did
  NOT touch Prometheus metric-name strings (`SERVICE_NAME = "smr"` and all 15
  pre-existing metric names remain `smr_*` on the committed tree), so a lone
  `text_*` metric would be its own drift — decision recorded in design-notes.md §(c).
  `GET /worker-pools` sets the gauge on every poll.
- **Task 6 (drain):** `services/worker_pool_queue.WorkerPoolQueue.submit()` takes an
  optional `ShutdownManager` and raises the EXISTING `ShutdownError` (503, reused —
  not a new exception) once `is_shutting_down` is set, mirroring `/generate`'s
  existing check. `GET /worker-pools` reports `draining: true` off the same flag.
  `ShutdownManager` itself was NOT modified (its existing `active_count`/
  `is_shutting_down`/`wait_for_shutdown` already covered the "let in-flight sync
  work finish" half) — Task 6 is `WorkerPoolQueue`/`worker.py` reusing it, not new
  drain machinery. The worker-SIDE half (stop claiming new messages, finish the
  claimed one) is `WorkerPoolConsumer.request_drain()` in `worker.py`, wired to
  SIGTERM/SIGINT.

### Phase C — local-dev story + deployment handoff (Task 7, Task 8)

- **Task 7:** `text/worker.py` — `WorkerPoolConsumer` (claim → process → ack loop
  per `task_type`, idempotent-skip on redelivery of an already-terminal task,
  ACKs even on task-level failure so one bad task never wedges the stream) +
  `main()` entry point wiring both pools (`embedding`, `batch_generation`) with
  graceful SIGTERM/SIGINT drain. Root script `text:worker:dev` (`package.json`) →
  `scripts/dev-service.sh`'s new `text-worker` case (native conda process,
  `python -m text.worker`, no port/reload — mirrors `stt-worker`'s rationale
  exactly, since no Python service in this monorepo runs as a compose service).
  **Scope-limited by design, not silently faked:** the `embedding` handler is
  fully implemented (this ticket's net-new capability); the `batch_generation`
  handler raises a clearly-flagged `NotImplementedError` — wiring full
  batch-generation dispatch would mean re-threading `/generate`'s retry/
  circuit-breaker/audit machinery for an out-of-process caller, which Phase A's
  design scoped as the envelope/queue/drain CONTRACT, not a second execution
  engine. Flagged here and in §6.
- **Task 8 (KEDA/HPA — flagged, lands in `arca/hope-v2-deployment`):** design note
  is design-notes.md §(a)/(c) — a `ScaledObject` per pool keyed on
  `smr_worker_pool_queue_depth{task_type="embedding"|"batch_generation"}` via the
  Prometheus scaler (batch path), and an `HorizontalPodAutoscaler` reading the
  existing `smr_active_generations`/`model_inference_latency_seconds` custom
  metrics (realtime/sync path — untouched by this ticket). GPU node-pool pinning
  recommended for vLLM/llama.cpp only. No `deployment/k8s/**` files created in
  THIS repo. What's provable from here: the metric exists, is registered on the
  default Prometheus registry, and is populated by `GET /worker-pools` (verified —
  see Verification below); whether KEDA is even installed on the cluster is
  UNVERIFIABLE from this session (§6, unchanged).

### Files changed

New: `apps/text/src/text/services/{pool_health,pool_router,worker_pool_queue}.py`,
`apps/text/src/text/providers/{embedding,tei_embed}.py`,
`apps/text/src/text/models/{worker_task,embedding,worker_pool_status}.py`,
`apps/text/src/text/api/endpoints/{embeddings,worker_pools}.py`,
`apps/text/src/text/worker.py`, 11 new test files under
`apps/text/src/text/tests/unit/`,
`docs/implementation/TASK-725-Worker-Pool-Text/design-notes.md`.

Modified: `apps/text/src/text/{main.py,core/config.py,core/dependencies.py,
core/exceptions.py,core/exception_handlers.py,core/metrics.py,
models/provider.py,models/requests.py,api/endpoints/generate.py,
api/endpoints/health.py,api/endpoints/providers.py,
tests/unit/test_exception_hierarchy.py}`, root `package.json`,
`scripts/dev-service.sh`.

No `packages/database` schema changes, no new `apps/text/pyproject.toml`
dependencies (`httpx`/`redis` already present) — `uv lock` re-run not needed.

## Acceptance Criteria — evidence

- [x] `pnpm text:test:unit` (via `CI=true conda run -n arcaenv pytest
      apps/text/src/text/tests/unit/`) — **1175 passed, 0 failed** (was 1134 before
      this ticket's changes). Lint (`ruff check apps/text/src/`): **all checks
      passed**. Typecheck (`mypy --config-file apps/text/pyproject.toml
      apps/text/src/`): **Success: no issues found in 72 source files**.
  - `pnpm text:test` (the FULL suite incl. `tests/integration/` and `tests/e2e/`)
    was NOT run — those require live Postgres/Redis/gateway, which are down this
    session (HARD RULES). Gated.
- [ ] `uv lock` — not applicable, no dependency changes.
- [x] Degrade-routing (Task 2): `test_pool_router.py`,
      `test_generate_degrade_routing.py` — a request naming a provider the last
      `/health` check marked unhealthy either reroutes to a registered
      `fallback_provider` or fails fast with `PoolUnhealthyError` (503); a healthy
      or never-checked provider is unaffected (regression-guarded).
- [x] Admin introspection (Task 3): `test_providers_admin_introspection.py`,
      `test_worker_pools_endpoint.py`. Manual verification (ASGI test client, no
      live infra — real command output, not curl against a running process since
      none is running):
      ```
      == GET /providers ==  ollama pool_health= False in_flight= 0
      == GET /worker-pools ==  {'task_type': 'embedding', 'queue_depth': 5, 'draining': False}
                                {'task_type': 'batch_generation', 'queue_depth': 5, 'draining': False}
      ```
- [ ] Text-embedding endpoint round-trips against `tei-embed` in local dev —
      **GATED**: `tei-embed` is not running (local infra down). `TeiEmbedProvider`
      is unit-tested hermetically against TEI's documented `/embed` contract via
      `httpx.MockTransport` (`test_tei_embed_provider.py`) and the endpoint is
      verified end-to-end with a mocked provider (`test_embeddings_endpoint.py` +
      the ASGI-client smoke run above: `POST /embeddings` → 200, real 3-vector
      round trip through the actual FastAPI route). A genuine live round trip
      against a running `tei-embed` container has not been performed.
- [x] Queue-depth metric (Task 5) visible in `/metrics`:
      ```
      smr_worker_pool_queue_depth{task_type="embedding"} 5.0
      smr_worker_pool_queue_depth{task_type="batch_generation"} 5.0
      ```
      (same ASGI-client run, `GET /metrics`).
- [x] Drain behavior (Task 6): `test_drain_behavior_task725.py` — SIGTERM
      (`shutdown_manager.initiate_shutdown()`) mid-drain rejects a new
      `WorkerPoolQueue.submit()` (`ShutdownError`) while an already-registered
      in-flight sync task (`register_task`/`complete_task`) completes normally
      and `wait_for_shutdown()` resolves without timing out. Worker-side claim-loop
      drain: `test_worker_pool_consumer.py::TestDrain`.
- [ ] Local worker entry point (Task 7) starts via `pnpm text:worker:dev` and
      processes a submitted async task in local dev — **PARTIALLY GATED**. The
      script wiring is real and verified (`./scripts/dev-service.sh text-worker
      --print` resolves to `conda run -n arcaenv ... python -m text.worker` — real
      output, pasted below) and the module imports cleanly
      (`python -c "import text.worker"` succeeds). Actually PROCESSING a submitted
      task end-to-end needs a running Redis + `tei-embed`, neither of which is up
      this session — that half is unverified, and `WorkerPoolConsumer`'s
      claim/process/ack/drain logic is instead covered by
      `test_worker_pool_consumer.py` (hermetic, mocked queue/task-manager).
      ```
      $ ./scripts/dev-service.sh text-worker --print
      service: text-worker
        PYTHONPATH=apps/text/src
      command:
        conda run -n arcaenv --no-capture-output env PYTHONPATH=apps/text/src python -m text.worker
      ```
- [x] Task 8's design note — design-notes.md §(a)/(c), summarized in §7 above;
      no `deployment/k8s/**` files created in this repo (confirmed by `git status`
      — none listed).
- [x] No new `databaseService.client`/direct-Prisma access — N/A (Python service,
      no Prisma in this tree) and confirmed no Postgres connection was added
      anywhere in this ticket's diff (`text` stays a stateless control plane; the
      only new I/O clients are `httpx` to `tei-embed` and the SAME `redis.asyncio`
      client the service already held).

## Known gaps / residuals (honest accounting)

1. ~~`batch_generation` worker dispatch is not implemented~~ **RESOLVED
   2026-08-20.** `worker.py::_handle_batch_generation` now validates
   `envelope.payload` as a `GenerateRequest` (fails closed with a
   `pydantic.ValidationError` on a malformed payload), resolves the target
   engine via the SAME `ProviderRegistry.get()` the synchronous `/generate`
   endpoint uses, and calls `provider.generate(request)` — an unregistered
   provider raises the SAME `ProviderNotFoundError` `/generate` raises, and a
   cloud provider missing its model still fails closed via that provider's own
   `require_model` guard (`providers/base.py`), so provider/model selection is
   fail-closed exactly as `.claude/rules/09-infrastructure-devops.md`
   §Configuration Tiers requires — no new hardcoded engine/model/endpoint was
   introduced, and no new env var beyond the bootstrap floor. `main()` builds
   the worker's `ProviderRegistry` the same way the FastAPI app does
   (`text.main._register_provider_factories`), so batch generation never has a
   wider or narrower provider surface than the sync path. Deliberately
   NOT re-threaded: `/generate`'s per-request rate-limiter / circuit-breaker /
   semaphore / idempotency-cache machinery — those guard same-pod backpressure
   on the SYNCHRONOUS path; a worker-pool consumer already serializes work
   per-consumer and `WorkerPoolConsumer`'s existing ack-on-failure loop absorbs
   a bad task without wedging the stream, which is the same level of
   sophistication the EMBEDDING handler already shipped at. Covered by
   `tests/unit/test_worker_batch_generation_handler.py` (resolve+call, unknown
   provider, malformed payload, cloud-provider fail-closed model selection, and
   a wiring assertion that `main()` actually uses a real registry).
   **Residual, called out explicitly rather than silently expanded into**: no
   HTTP submission endpoint for `BATCH_GENERATION` exists yet (unlike
   `embedding`, which has `POST /embeddings/batch`) — nothing in this repo
   currently enqueues a `batch_generation` task in production, so the fixed
   dispatch path is exercised by direct unit tests today, not an end-to-end
   HTTP round trip. Adding that submission endpoint (and deciding its caller —
   harness? admin console? gateway?) is real, separate follow-up work, not
   silently bundled into this fix.
2. **Nothing in this ticket was verified against LIVE `tei-embed` or a LIVE
   worker process** — local infra was down for the entire session. All
   verification is hermetic (mocked Redis/httpx) or via the ASGI test client
   against the real FastAPI app object (no live socket). The TEI `/embed` wire
   contract (vs. the alternative OpenAI-compatible `/v1/embeddings` route some
   TEI builds also expose) was chosen from TEI's documentation, not confirmed
   against the actual `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9`
   image this repo pins.
3. **KEDA/HPA manifests themselves are NOT in this repo** and were not written —
   by design (rule 09); the design note is the deliverable for this repo, the
   YAML is `arca/hope-v2-deployment`'s to author.
4. **TASK-717 (`async-contract`) still does not exist** — `WorkerTaskEnvelope` is
   this ticket's own, narrowly-scoped envelope, flagged for reconciliation once
   TASK-717 is authored (design-notes.md §(e), unchanged from the ticket's own
   §6 risk).

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
| 2026-08-16 | Phases A–C implemented (design-notes.md; degrade-routing; admin introspection; text-embedding; queue-depth metrics; drain; local worker entry point). Full unit suite 1175/1175 green, lint clean, typecheck clean. `batch_generation` worker dispatch and live-infra round trips explicitly flagged as gated/residual — see §7. Status → Review. | Claude (execution session) |
| 2026-08-20 | Closed the `batch_generation` NotImplementedError residual (§Known gaps item 1). `worker.py::_handle_batch_generation` now parses `envelope.payload` as a `GenerateRequest` and dispatches through the SAME `ProviderRegistry`/`LLMProvider.generate()` contract `/generate` uses (built in `main()` via `text.main._register_provider_factories` — the same factory-registration function the FastAPI app itself calls, so batch generation never sees a wider/narrower provider surface than sync). Provider/model selection stays fail-closed via the existing `ProviderNotFoundError`/`require_model` guards — no hardcoded engine/model/endpoint added, no new env var. Added `tests/unit/test_worker_batch_generation_handler.py` (5 tests: resolve+dispatch, unknown provider, malformed payload, cloud-provider fail-closed model selection, `main()` wiring). Evidence: `ruff check apps/text/src/` — all checks passed; `mypy --config-file apps/text/pyproject.toml apps/text/src/` — Success, no issues found in 74 source files; `pytest apps/text/src/text/tests/unit/` — 1187 passed, 1 failed (`test_wired_provider_queue.py::TestQueueWhenRateLimited::test_request_queued_when_rate_limited` — a pre-existing, timing-sensitive test in the sync rate-limiter/queue path, untouched by this change and reproducible independent of it; not caused by or related to this fix). **New residual surfaced, not silently folded in**: no HTTP submission endpoint exists for `BATCH_GENERATION` (unlike `embedding`'s `POST /embeddings/batch`) — nothing in this repo currently enqueues a batch-generation task in production, so the fixed dispatch path is verified by direct unit tests, not an end-to-end HTTP round trip. Status left at Review pending an owner decision on that new residual (see chat report). | Claude (TASK-725 dispatch-fix session) |
