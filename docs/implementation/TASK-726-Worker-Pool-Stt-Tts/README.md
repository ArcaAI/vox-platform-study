# TASK-726 — Worker Pool: `stt` + `tts` (Apply the TASK-725 Pattern)

| | |
|---|---|
| **Status** | Review |
| **Wave** | 3 · **Size** | M |
| **Epic slug** | `worker-pool-stt-tts` |
| **Depends on** | TASK-725 (`worker-pool-text` — this ticket follows its control-plane/registry/
  degrade-routing/metrics pattern; do not re-derive it independently) |
| **Design refs** | [design.md](../../programs/agentic-workflow-platform/design.md) §Services program ("Worker-pool standard") |
| **Findings closed** | — (infrastructure-scaling ticket; does not close a numbered assessment finding) |

## 1. Requirement Analysis

Apply TASK-725's worker-pool control-plane pattern — registry, health, degrade-routing, admin
introspection, KEDA/HPA-ready metrics — to `apps/stt` (realtime + batch ASR) and `apps/tts`
(speech synthesis). Unlike `text` (TASK-725), where almost none of this exists yet, **`stt` already
has a substantial fraction of the target architecture built** (§2.1). This ticket's job is
therefore narrower and more surgical than TASK-725's: identify what's REUSED unchanged, what needs
extension, and — for `stt`'s realtime path specifically — solve a wrinkle TASK-725 does not have:
**streaming sessions pin to the worker process that created them**, so naive HPA scale-down would
sever live audio sessions mid-consultation.

`tts` has almost nothing of the pattern today (§2.2) — closer to `text`'s starting point — but its
GPU-bound local engines (Kokoro, Indic Parler) and its lack of ANY batch/queue use case (§2.2)
mean it needs the control-plane/health/GPU-pinning half of the pattern but explicitly NOT a KEDA
queue-depth path, since no queue exists or is needed.

**Explicitly OUT of scope:**
- Rebuilding `stt`'s existing Dramatiq batch worker, engine registry, or streaming session manager
  — all REUSED (§2.1). This ticket extends them with degrade-routing, admin introspection, and
  session-draining; it does not replace them.
- Adding a batch/async worker to `tts` — no batch/queue use case exists in the code today (§2.2);
  building one speculatively violates the karpathy "no speculative flexibility" guideline. If a
  real batch-synthesis need emerges later, it is a new ticket built on this one's control-plane
  scaffolding.
- The k8s/KEDA/HPA manifest YAML itself — lands in `arca/hope-v2-deployment`, same as TASK-725
  Task 8, flagged the same way.
- TASK-707's naming work — `stt` and `tts` keep their current names (only `smr`→`text` renames).

## 2. Current State Evaluation

**Verified 2026-08-16 against `apps/stt/src/stt/` and `apps/tts/src/tts/`.**

### 2.1 `apps/stt` — batch worker pool ALREADY EXISTS; realtime does NOT

**Batch ASR: already matches the target pattern closely.**

- `apps/stt/src/stt/worker.py:1-23` is a genuine **out-of-process Dramatiq worker entry point**
  (`stt-worker` console script / `python -m stt.worker`), fundamentally different from `text`'s
  current in-process-only state (TASK-725 §2.2). Root `package.json:116` already exposes
  `stt:worker:dev` — this is the naming precedent TASK-725 Task 7 imitates.
- `apps/stt/src/stt/core/messaging/broker.py:1-49` configures a `dramatiq.brokers.redis.RedisBroker`
  with `Retries`/`TimeLimit`/`AgeLimit`/`Results` middleware and a custom `should_retry` (`:22-42`)
  that never retries `NON_RETRYABLE_EXCEPTIONS`. `_add_prometheus_middleware` (`:45-...`) already
  solves the exact problem TASK-725 Task 5 has to build from scratch for `text`: **the worker is a
  separate process from the FastAPI app, so its own `/metrics` says nothing about it** (comment at
  `broker.py:47-49`, verbatim) — it wires Dramatiq's own Prometheus middleware with
  `PROMETHEUS_MULTIPROC_DIR` fork-aggregation instead of a hand-rolled exporter, specifically
  because the worker forks (`--processes N`) and naive counters would be per-fork and wrong.
  **Reuse this middleware wiring as the model for any additional STT worker metrics this ticket
  adds — do not hand-roll a second exporter.**
- Batch task envelope already exists:
  `apps/stt/src/stt/transcription/workers/transcribe_file.py:31-51` — a
  `@dramatiq.actor(queue_name="stt_batch", max_retries=3, min_backoff=10000, max_backoff=300000,
  time_limit=...)` actor with a plain-kwarg envelope (`job_id, tenant_id, pipeline_id, audio_uri,
  ...`). **This is the exemplar TASK-725 Task 1 cites for its own envelope design** — for `stt`,
  it needs no redesign, only a queue-depth metric wired to it (Task 2 below).
- Engine registry: `apps/stt/src/stt/processors/registry.py:1-45` — `ProcessorRegistry`, keyed
  `(kind, name)`, lazy-loaded (`:23-27` `register`, `:38-45` `spec`) — structurally the same shape
  as `text`'s `ProviderRegistry` (TASK-725 §2.1) but with ONE capability `text` lacks entirely:
  `apps/stt/src/stt/processors/base.py:39-58` — `Capability` declares
  `device: str  # "cpu" | "cuda" | "mps" | "cloud"` per processor, and `HardwareBinding` records the
  RESOLVED device a processor loaded with. **`stt` already models GPU-vs-CPU-vs-cloud per engine at
  the code level** — this is the primitive TASK-725 has no equivalent of and had to defer to the
  deployment repo entirely; here it can inform an actual routing/health decision in-repo.
- Engine set (correcting design.md's "whisper, nemo, cloud engines" — verify-before-cite, per the
  ticket-template rule): the actual loader set under `apps/stt/src/stt/models/` is far broader —
  `faster_whisper_loader.py`, `whisper_cpp_loader.py`, `nemo_loader.py`/`nemo_adapter.py`,
  `parakeet_cpp_loader.py`, `onnx_loader.py`, `huggingface_loader.py`, plus cloud/API engines
  `azure_speech_loader.py`, `azure_foundry_loader.py`, `openai_loader.py`, `sarvam_loader.py`,
  `cloud_asr.py`. Design.md's "whisper, nemo, cloud" is a simplification, not wrong, but this
  ticket's Task 1 design note should enumerate the real set since GPU-pinning decisions differ per
  engine (e.g. `parakeet_cpp`/`whisper_cpp` are CPU-capable; `nemo` typically wants CUDA).

**Realtime ASR: the session-affinity wrinkle is real and unaddressed today.**

- `apps/stt/src/stt/streaming/session_manager.py:1-13` (module docstring) documents the existing
  shape precisely: *"Worker heartbeat — register `stt:worker:{worker_id}` with TTL, extend
  periodically so other workers can detect crashes."* `SessionManager.__init__`
  (`:167-175`) sets `self._worker_id = worker_id or f"worker-{uuid.uuid4().hex[:8]}-{os.getpid()}"`
  — **the worker id is process-local**, and `self._sessions`-equivalent state (session→runtime
  mapping, `_session_pinned_models`, etc.) lives **in that process's memory**, not in Redis or any
  shared store. A session created via `POST /internal/streaming/sessions`
  (`apps/stt/src/stt/streaming/api/routes.py:1-36`, called by
  `apps/api/src/modules/streaming/stt-ws.gateway.ts:195-196`'s `SttWsGateway`) is therefore pinned
  to whichever STT pod/process handled that request — **every subsequent call for that session
  (push audio, switch provider, teardown) must reach the SAME process**, or it 404s against that
  process's local session dict.
- `apps/stt/src/stt/streaming/session_manager.py` module docstring also documents **"Recovery on
  startup — scan `stt:session:*` for `status: active`, replay last ~2 s of audio to warm RNNoise /
  VAD state, resume consuming."** This is a CRASH-RECOVERY mechanism (a restarted process reclaims
  orphaned sessions by replaying recent audio), explicitly NOT a graceful-drain mechanism — it
  exists for unplanned process death, not planned scale-down. **Do not conflate the two when
  building Task 3 (draining) below**; scale-down draining should let a session finish naturally
  (stop routing new sessions to a pod marked for removal, wait for its active sessions to end or
  hit a bounded timeout), while startup recovery already handles the crash case correctly and is
  reused unchanged.
- `apps/stt/src/stt/streaming/capacity_guard.py:18-40` — `CapacityGuard` is an existing
  `asyncio.Lock`-guarded concurrent-stream limiter against `max_concurrent_streams`; at capacity it
  signals the gateway to return HTTP 503 + `Retry-After` (module docstring `:1-7`). This is the
  existing backpressure signal; HPA should ideally scale up BEFORE this ceiling is hit, using the
  metric in the next bullet as the leading indicator.
- Metrics already exist that are directly usable as HPA custom metrics:
  `apps/stt/src/stt/core/metrics.py:72-77` — `STREAMING_SESSIONS_ACTIVE` (Gauge) and `:167-171`
  `WORKER_JOBS_IN_PROGRESS` (Gauge, batch-worker side). **No new metric is required to start an HPA
  design conversation** — unlike `text` (TASK-725), which had to add these from scratch.
- Config: `apps/stt/src/stt/core/config/settings.py` — the bulk of `Settings` presumably carries a
  prefix consistent with `.claude/rules/06-python-services.md`'s documented `STT_` prefix, but a
  specific carve-out exists: the S3 model-source bootstrap credentials (`model_s3_endpoint` etc.,
  `settings.py:188-200`) are wired via explicit `AliasChoices("STT_MODEL_S3_ENDPOINT",
  "STT_V2_MODEL_S3_ENDPOINT")` rather than prefix inheritance, because — per the comment at
  `:189-190` verbatim — *"every service shares one env file, and un-prefixed names would collide."*
  Verify the exact prefix behavior for any NEW setting this ticket adds against the live class
  before assuming plain `STT_` works; do not copy the S3 carve-out's alias pattern unless the same
  collision risk applies.

### 2.2 `apps/tts` — closer to `text`'s starting point; corrected engine list; no queue use case

- **Providers (correcting the catalog, per this ticket's explicit brief):** the design.md services
  table says *"engines are Azure Speech + local Kokoro/Indic Parler (the catalog's whisper/nemo/
  Transcribe list was a copy-paste from ASR)"* — CONFIRMED as far as it goes
  (`apps/tts/src/tts/providers/azure_speech.py`, `kokoro.py`, `indic_parler.py` all exist), but the
  actual provider set is BROADER than "Azure + Kokoro/Indic Parler" states: `apps/tts/src/tts/providers/`
  also contains `indic_f5.py` and `sarvam.py`, both registered the same way as the other locals
  (`apps/tts/src/tts/providers/registration.py:20-42` — `register_local_provider`, generic across
  all local engines, always registers regardless of warmup success per its own docstring `:1-9`).
  Config confirms five provider prefixes, not two:
  `TTS_AZURE_` (`config.py:35`), `TTS_KOKORO_` (`:64`), `TTS_PARLER_` (`:77`), `TTS_INDICF5_`
  (`:106`), `TTS_SARVAM_` (`:127`), plus base `TTS_` (`:154`). This ticket's Task 1 design note
  should carry the corrected 5-provider list; it is a factual refinement, not a re-litigation of
  design.md's fork resolution (no decision-log entry names TTS's provider count).
- **No worker/queue exists**: `grep -rl "dramatiq\|celery" apps/tts/src` — zero hits, same as `text`
  pre-TASK-725.
- **No batch/async use case exists to justify one**: `apps/tts/src/tts/api/endpoints/speech.py:5`
  documents response modes as `unset → full audio response (batch)` — "batch" here means
  **synchronous full-buffer response**, not an async job; there is no long-running TTS job type in
  the codebase today. Building a Dramatiq worker for TTS in this ticket would be speculative
  (karpathy §2 Simplicity First) — explicitly out of scope (§1) unless a real requirement surfaces.
- **Stateless-by-design, confirmed authoritative**: `packages/database/src/prisma/db_main/tenant-tts-config.prisma:4-6`
  states outright: *"DB-backed, tenant-admin-editable TTS 'spec', resolved at request time by the
  apps/api gateway and injected into the STATELESS apps/tts service (the Python service never
  touches Postgres)."* This is the gateway-resolved-injection pattern
  `.claude/rules/06-python-services.md` §"Per-tenant config in a Python service" names as the
  DEFAULT for a stateless service — `tts`'s control-plane work in this ticket must preserve this;
  no new DB connection.
- **Correction to `.claude/rules/06-python-services.md`**: that rule's exemplar,
  `TenantTtsProviderCredential`, **no longer exists** — `tenant-tts-config.prisma:16-21` documents
  it was DROPPED and its rows migrated into the unified `AiProviderConnection` table
  (`service='tts'`); `TenantTtsConfig` (the still-current model, `tenant-tts-config.prisma:24-62`)
  is the per-tenant SPEC (voice defaults, routing, allowed providers), while credentials live in
  `AiProviderConnection`. Flagging this so a future rule-maintenance pass corrects the rule; not
  this ticket's job to edit `.claude/rules/**`.
- **GPU**: no existing CUDA/MPS/device config surfaced in `apps/tts/src/tts/core/config.py` for
  Kokoro/Indic Parler/Indic F5 (unlike `stt`'s explicit `Capability.device` model, §2.1) — this
  ticket's Task 1 design note should decide whether to import `stt`'s `Capability`/`HardwareBinding`
  shape (via a shared package) or keep `tts`'s device awareness informal for v1; do not silently
  skip the decision.
- No `tts:` compose service exists (same as `stt`/`smr` — all six Python services run natively via
  conda in local dev, confirmed for `tts` by absence in `infrastructure/docker/docker-compose*.yml`).
  No `tts:worker:dev` root script exists (consistent with §2.2 above — there is no worker to start).

## 3. Knowledge & Best Practices

- TASK-725's §3 (Knowledge & Best Practices) applies verbatim to the shared control-plane concerns
  (env-tier config, gateway-resolved injection, `.claude/rules/09-infrastructure-devops.md`
  §Cluster Deploys deployment-repo boundary, `X-Service-Token` on new internal endpoints,
  `structlog` dotted event names) — not re-derived here.
- `.claude/rules/06-python-services.md` §Temporal is NOT relevant here (`stt`/`tts` do not use
  Temporal); §"Streaming: STT streams over Redis Streams" is the one line in that rule this ticket
  directly extends — confirm the citation (`apps/stt/src/stt/streaming/api/routes.py`) still points
  at the internal session-management router, not the raw Redis Streams transport itself (that lives
  in `apps/stt/src/stt/streaming/redis_streams.py`, a sibling file — verify which one a given task
  actually needs before editing).
- Known pitfall (session draining, Task 3): do NOT reuse the startup-recovery "replay last ~2s of
  audio" mechanism for planned scale-down (§2.1) — recovery is for crash restart; draining is for
  "stop sending new sessions here, let existing ones finish or migrate." Conflating them would make
  every planned pod rotation look and behave like an audio glitch to the clinician.
- Known pitfall (TTS batch worker): resist adding one speculatively (§1, §2.2) — the "no worker
  exists" state is CORRECT today, not a gap, until a real async TTS use case is named.
- TDD ordering per `.claude/rules/01-development-workflow.md` — failing test first in
  `apps/stt/src/stt/tests/unit/` (`pnpm stt:test:unit`, root `package.json:118`) and
  `apps/tts/src/tts/tests/unit/` (`pnpm tts:test:unit`, root `package.json:201`).

## 4. Implementation Plan

### Task 1 — Design note: STT realtime draining + TTS control-plane shape
- **Agent:** T3 · sonnet-5 · high
- **Files:** `docs/implementation/TASK-726-Worker-Pool-Stt-Tts/design-notes.md` (new)
- **Approach:** Two design decisions, informed by TASK-725 Task 1 but not duplicating it: (a) the
  STT realtime draining protocol — how a pod marked for removal stops receiving NEW sessions
  (likely: `SttWsGateway`/gateway-side routing needs a way to learn a given STT instance is
  draining, per-instance Redis key akin to the existing `stt:worker:{worker_id}` heartbeat,
  §2.1) while letting in-flight sessions finish or hit a bounded grace timeout; (b) whether TTS
  imports `stt`'s `Capability`/`HardwareBinding` device model (§2.2) or defines its own — recommend
  based on whether extracting it into a shared package is proportionate for two consumers, per
  karpathy §2 (no speculative abstraction for a single reuse).
- **Verify:** Design note reviewed against §1's scope boundary (no new TTS worker/queue).

### Task 2 — STT batch worker: queue-depth metric for KEDA
- **Agent:** T2 · sonnet-5 · low
- **Files:** `apps/stt/src/stt/core/metrics.py` (extend), `apps/stt/src/stt/core/messaging/broker.py`
  (wire into the existing `_add_prometheus_middleware`, §2.1 — do not add a second exporter)
- **Approach:** Failing test first. Redis LLEN (or Dramatiq's own queue-size introspection, if
  exposed) for `stt_batch` becomes a Gauge, following the multiproc-safe pattern
  `broker.py:45-...` already established. This is the metric a `ScaledObject` in the deployment
  repo would read — same handoff shape as TASK-725 Task 5/8.
- **Verify:** `pnpm stt:test:unit`; `curl localhost:8861/metrics | grep <new_metric>`.

### Task 3 — STT realtime: draining + degrade-routing
- **Agent:** T3 · sonnet-5 · high
- **Files:** `apps/stt/src/stt/streaming/session_manager.py` (extend — add a draining flag/state,
  distinct from the existing recovery path per §2.1/§3 pitfall), `apps/stt/src/stt/health/api/routes.py`
  (expose draining state so a `preStop` hook or the gateway can poll it — mirrors TASK-725 Task 3's
  admin introspection endpoint), `apps/api/src/modules/streaming/stt-ws.gateway.ts` (if Task 1's
  design requires the gateway to stop routing new sessions to a draining instance — verify current
  routing logic first; this file already has extensive multi-instance awareness per its own
  comments, §2.1, so extend that existing awareness rather than building new instance-tracking).
- **Approach:** Failing test first — a test that marks a `SessionManager` instance draining and
  asserts (a) `create_session` rejects new sessions with a signal the gateway can route around, (b)
  existing sessions in `self._sessions` continue processing audio until they end or a bounded
  timeout fires.
- **Verify:** `pnpm stt:test:unit`; `pnpm test:unit` (apps/api side) if the gateway changed —
  paste both outputs.

### Task 4 — TTS control plane: registry health + admin introspection
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/tts/src/tts/providers/registration.py` (extend registry with health-check-driven
  degrade routing, mirroring TASK-725 Task 2's pattern against `text`'s `ProviderRegistry`),
  `apps/tts/src/tts/api/endpoints/health.py` (extend for per-provider status, mirroring TASK-725
  Task 3)
- **Approach:** Failing test first, same shape as TASK-725 Task 2/3 but against `tts`'s 5-provider
  registry (§2.2) instead of `text`'s 9-provider one. No async task envelope needed here (§1) — this
  is purely the synchronous-path health/routing/introspection half of the pattern.
- **Verify:** `pnpm tts:test:unit`.

### Task 5 — TTS GPU/device awareness for local engines
- **Agent:** T2 · sonnet-5 · medium
- **Files:** per Task 1's decision — either import `stt`'s `Capability`/`HardwareBinding`
  (`apps/stt/src/stt/processors/base.py:39-58`) via a new shared package, or add an equivalent
  informal `device` field to `apps/tts/src/tts/core/config.py`'s Kokoro/Indic Parler/Indic F5
  configs.
- **Approach:** Declare which of the five TTS providers are GPU-bound (Kokoro, Indic Parler, Indic
  F5 — local ML models) vs. API-bound (Azure, Sarvam — no local device) so the deployment repo has
  something correct to pin node pools against, matching design.md's "GPU engines pin node pools."
- **Verify:** `pnpm tts:test:unit`; `pnpm tts:typecheck`.

### Task 6 — Local-dev story
- **Agent:** T1 · haiku-4-5 · default
- **Files:** none new for `tts` (no worker to launch, §1); confirm `stt:worker:dev`
  (`package.json:116`) already covers the STT worker local-dev story — if Task 2/3 added new
  startup flags (e.g. a draining-aware graceful-shutdown mode), document the manual
  `pnpm stt:worker:dev` verification steps in this ticket's §7, not a new script.
- **Verify:** `pnpm stt:worker:dev` starts against local Redis; manual smoke test of Task 3's
  draining flag via a signal or admin call.

### Task 7 — [FLAGGED: lands in `arca/hope-v2-deployment`] KEDA + HPA manifests for stt/tts
- **Agent:** T3 · sonnet-5 · medium (follows TASK-725 Task 8's shape) — executed against the
  deployment repo, not this one.
- **Files:** none in this repo.
- **Verify (from THIS repo):** Task 2's queue-depth metric and Task 3's draining-state signal are
  both scraped/queryable (Prometheus config + a manual `curl`), and Task 3's drain behavior is
  proven by the unit test in Task 3 — not by inspecting a `preStop` hook this repo cannot see.

## 5. Acceptance Criteria

- [x] `pnpm stt:test` and `pnpm tts:test` — all new and existing tests pass; paste output. (Run
      directly via `~/miniconda3/envs/arcaenv/bin/python -m pytest` — the `conda run` wrapper is
      broken in this environment per the HARD RULES. `apps/stt/tests/integration/` and `e2e/` were
      NOT run — no live Postgres/Redis/API this session; gated.)
- [x] `pnpm stt:lint` / `pnpm stt:typecheck` and `pnpm tts:lint` / `pnpm tts:typecheck` — clean;
      paste output.
- [x] `uv lock` re-run at repo root if either service's `pyproject.toml` changed. — N/A, neither
      `pyproject.toml` changed (confirmed via `git status`).
- [x] Queue-depth metric (Task 2) visible in STT `/metrics` output — pasted (no live server this
      session; pasted from the real `prometheus_client.generate_latest()` output the metric is
      served from, with the broker's `do_qsize` monkeypatched to a known value — same mechanism
      `/metrics` at :8861 reads).
- [x] Draining behavior (Task 3) covered by a test proving new sessions are rejected while in-flight
      sessions complete — distinct from the existing crash-recovery path, which remains untouched
      and still passes its existing tests (2791/2791 STT unit tests green, including the
      pre-existing recovery-path suites).
- [x] TTS admin introspection endpoint (Task 4) returns per-provider health for all 5 providers —
      pasted (ASGI test-client output, not `curl` against a running process — none is running this
      session; ASGI-client-against-the-real-app is the same evidence class TASK-725 used for the
      identical reason).
- [x] GPU/device classification (Task 5) documented for all 5 TTS providers.
- [x] `pnpm test:unit` (apps/api) passes if `stt-ws.gateway.ts` was touched by Task 3. — N/A,
      `stt-ws.gateway.ts` was NOT touched (design-notes.md §(a): the k8s-readiness mechanism needs
      no gateway change; confirmed via `git status`, no `apps/api/**` file appears in this ticket's
      diff).
- [x] Task 7's design note written into §7, scoped as deployment-repo work, no `deployment/k8s/**`
      files created in this repo (confirmed by `git status` — none listed).

## 6. Risks & Open Questions

- **Risk:** the realtime draining protocol (Task 3) requires SOME coordination signal between the
  gateway (`apps/api`) and a specific STT instance. If Task 1's design lands on a Redis-based
  per-instance draining key (extending the existing `stt:worker:{worker_id}` heartbeat, §2.1), that
  is a TS+Python cross-language contract — keep it to a documented key format, not a shared schema
  package, to avoid overbuilding for two consumers (karpathy §2).
- **Open question:** does the gateway's existing multi-instance socket-count tracking
  (`stt-ws.gateway.ts`, §2.1/§3) already have enough of a "which instance owns this session" model
  to make draining cheap, or does it only track aggregate counts today? Verify during Task 1 before
  committing to an approach in Task 3 — this ticket's author has not read that file exhaustively
  enough to assert either way, only that it exists and is instance-aware in some form.
- **Unverifiable from this repo:** same caveat as TASK-725 §6 — whether KEDA/HPA infra exists on
  the cluster at all.
- **Risk:** if TASK-725 lands with a different metric-naming or admin-introspection-endpoint shape
  than assumed here, Task 4's TTS mirror and Task 2/Task 5 of TASK-726 should be re-checked against
  TASK-725's ACTUAL Implementation Summary (§7 there) before merging, not against this ticket's
  prediction of it.

## 7. Implementation Summary

Executed on branch `feat/loop` against the committed post-TASK-707 tree. Local infra
(Postgres/Redis/API/Temporal) was DOWN for the whole session — no cluster access either — so
everything below was verified with hermetic unit tests (mocked Redis/broker/httpx, ASGI/FastAPI
`TestClient`) rather than live services; every item that genuinely needs live infra is called out
as gated, not claimed as done. `conda run -n arcaenv` is broken in this environment (per HARD
RULES) — every command below was run directly via `~/miniconda3/envs/arcaenv/bin/{python,ruff,mypy}`,
which is the exact interpreter `pnpm <svc>:test/lint/typecheck` resolve to.

### Task 1 — Design note

`docs/implementation/TASK-726-Worker-Pool-Stt-Tts/design-notes.md` — resolves §6's open question
(the gateway does not hold a per-STT-pod routing table; the correct draining signal is k8s
readiness, not a gateway code change or a Redis-based routing key), the TTS device-model decision
(no shared `Capability`/`HardwareBinding` package — a static classification constant is
proportionate), and a current-state correction found while implementing Task 4: TTS already has
per-provider `CircuitBreaker` degrade-routing (`routing/router.py`), so Task 4 is scoped down to
admin introspection only, not a TASK-725-style rebuild.

### STT — Task 2 (queue-depth metric)

`core/metrics.py` gained `stt_worker_queue_depth{queue}` (Gauge). Wired inside the EXISTING
`_add_prometheus_middleware` (`core/messaging/broker.py`, new `_wire_queue_depth_gauge` helper) via
`Gauge.set_function` reading the broker's own `do_qsize("stt_batch")` (Dramatiq's pending-message
primitive, not a hand-rolled Redis `LLEN`) — no periodic poller, computed lazily at scrape time,
reports `0.0` (not a crash) if Redis is unreachable. Runs in BOTH the FastAPI app process
(`main.py` lifespan → `initialize_redis()`) and the worker process, since both call
`configure_broker()`. Gated on the same `metrics_enabled` switch as every other exporter in that
function.

### STT — Task 3 (realtime draining)

`core/exceptions.SessionManagerDrainingError` (new) + `SessionManager.begin_drain()` /
`.is_draining` / `.wait_for_drain(timeout_s, poll_interval_s)` (`streaming/session_manager.py`).
`create_session()` checks `self._draining` FIRST (before the capacity guard) and raises the new
exception — a signal distinct from the ordinary at-capacity `None` return. `streaming/api/routes.py`
gained `POST /internal/streaming/drain` (calls `begin_drain()`, the `preStop`-hook target) and a
dedicated `except SessionManagerDrainingError` branch on `POST /sessions` returning 503
`detail="Draining"` (vs. `"At capacity"`). `health/api/routes.py`'s `readiness_check()` now also
fails once `session_manager.is_draining` — this is the ACTUAL "stop routing new sessions here"
mechanism (k8s removes the pod from Service Endpoints), so **no `apps/api` change was needed or
made** (design-notes.md §(a) explains why the gateway has no per-pod routing table to update).
`SessionManager.to_dict()` gained a `"draining"` key for `/internal/streaming/status` visibility.
The existing startup crash-recovery replay path is completely untouched — different code path
(`start()` vs. `create_session()`), proven by the full existing streaming test suite staying green.

One backward-compat fix required: the new `if self._draining:` check used `getattr(self,
"_draining", False)` rather than a bare attribute read, because 18 pre-existing unit tests build
`MagicMock(spec=SessionManager)` fixtures that predate this flag and never set it — a bare read
raised `AttributeError` through those fixtures. Real instances always have the attribute via
`__init__`; this is a defensive read for old test doubles, not a production behavior change.

### TTS — Task 4 (admin introspection) + Task 5 (GPU/device classification)

Current-state correction (design-notes.md §(c)): TTS's degrade-routing ALREADY EXISTED
(`routing/circuit_breaker.CircuitBreaker`, wired into `TTSRouter.candidates()`) — Task 4 does not
rebuild it, it adds the missing READ-ONLY view: new `GET /api/v1/providers`
(`api/endpoints/providers.py`, registered in `main.py`) returns, per registered provider: `healthy`
(the same `TTSEngine.health()` `/health/ready` already calls), `is_configured`, `breaker_open`
(the pre-existing `CircuitBreaker.is_open()`), `gpu_bound`, and `resolved_device`.

Task 5's classification is `GPU_BOUND_PROVIDERS = {"kokoro", "indic_parler", "indic_f5"}` /
`API_BOUND_PROVIDERS = {"azure", "sarvam"}` — a static module constant, not a new shared package
(design-notes.md §(b) explains why importing STT's `Capability`/`HardwareBinding` for a single
other reuse would be the karpathy §2 violation the ticket's own file list flags). Also corrects
§2.2's claim that "no device config exists" — `KokoroConfig`/`IndicParlerConfig`/`IndicF5Config`
already carry `device: str = "cpu"`, already wired into the loaders; the endpoint surfaces the
actual resolved value as `resolved_device` (best-effort `getattr`, `None` for cloud engines,
never raises).

### STT — Task 6 (local-dev story)

No new code needed. `pnpm stt:worker:dev` (`scripts/dev-service.sh stt-worker`) already covers the
STT worker; verified it still resolves correctly and that `stt.worker` imports cleanly with the new
queue-depth wiring active (output below). No `tts:worker:dev` exists and none was added — TTS has
no worker (§1/§2.2, unchanged by this ticket).

### Task 7 — [FLAGGED] KEDA/HPA manifests

Design note only, in design-notes.md §(d) (STT) and referencing §(b) (TTS's GPU-node-pool
recommendation). No `deployment/k8s/**` files created in this repo. What's provable from here: the
`stt_worker_queue_depth` metric exists, is registered on the default `prometheus_client` registry,
and reads the broker's live `do_qsize()`; the TTS `gpu_bound` classification is machine-readable
via `/api/v1/providers`. Whether KEDA/HPA is installed on the cluster is UNVERIFIABLE from this
session (same as TASK-725 §6).

### Files changed

New: `apps/tts/src/tts/api/endpoints/providers.py`,
`apps/stt/tests/unit/test_worker_queue_depth_task726.py`,
`apps/stt/tests/unit/streaming/test_session_manager_drain_task726.py`,
`apps/stt/tests/unit/test_streaming_api_drain_task726.py`,
`apps/stt/tests/unit/test_health_api_drain_task726.py`,
`apps/tts/src/tts/tests/unit/test_providers_endpoint_task726.py`,
`docs/implementation/TASK-726-Worker-Pool-Stt-Tts/design-notes.md`.

Modified: `apps/stt/src/stt/core/{exceptions.py,metrics.py,messaging/broker.py}`,
`apps/stt/src/stt/health/api/routes.py`, `apps/stt/src/stt/streaming/{session_manager.py,api/routes.py}`,
`apps/tts/src/tts/main.py`.

No `packages/database` schema changes. No `apps/{stt,tts}/pyproject.toml` dependency changes —
`uv lock` re-run not needed (confirmed via `git status`). No `apps/api/**` files touched.

## Acceptance Criteria — evidence

- **`pnpm stt:test` (unit only; `integration`/`e2e` gated — no live infra):**
  ```
  $ CI=true ~/miniconda3/envs/arcaenv/bin/python -m pytest apps/stt/tests/ \
      --ignore=apps/stt/tests/integration --ignore=apps/stt/tests/e2e -q
  2815 passed, 14 warnings in 19.06s
  ```
  (2791 of those are `apps/stt/tests/unit/` — the exact `stt:test:unit` target — all green,
  including every pre-existing streaming/session-manager suite; no regression.)
- **`pnpm tts:test`:**
  ```
  $ CI=true ~/miniconda3/envs/arcaenv/bin/python -m pytest apps/tts/src/tts/tests/ -q --no-cov
  267 passed, 2 deselected, 5 warnings in 7.21s
  ```
- **`pnpm stt:lint`:** `ruff check apps/stt/src/ apps/stt/tests/` → `All checks passed!`
- **`pnpm stt:typecheck`:** `mypy --config-file apps/stt/pyproject.toml apps/stt/src/` →
  `apps/stt/src/stt/transcription/preprocessing.py:278: error: Redundant cast ...` — **pre-existing,
  not introduced by this ticket** (that file is untouched — confirmed via `git status`; this
  ticket's own files are clean).
- **`pnpm tts:lint`:** `ruff check apps/tts/src/` → `All checks passed!`
- **`pnpm tts:typecheck`:** `mypy --config-file apps/tts/pyproject.toml apps/tts/src/` →
  `Success: no issues found in 35 source files`.
- **Queue-depth metric (Task 2), real `generate_latest()` output** (broker's `do_qsize`
  monkeypatched to a known value — the same call path `/metrics` at :8861 exercises at scrape
  time; no live server this session):
  ```
  # HELP stt_worker_queue_depth Pending (undelivered) Dramatiq messages waiting to be claimed by a worker, by queue
  # TYPE stt_worker_queue_depth gauge
  stt_worker_queue_depth{queue="stt_batch"} 12.0
  ```
- **Draining (Task 3):** `test_session_manager_drain_task726.py` (10 tests — `begin_drain`
  idempotency, `create_session` rejection distinct from capacity, `wait_for_drain` timeout/success,
  `to_dict` visibility), `test_streaming_api_drain_task726.py` (3 tests — HTTP 503 `"Draining"` vs.
  `"At capacity"`, the new `/internal/streaming/drain` endpoint), `test_health_api_drain_task726.py`
  (3 tests — `/health/ready` 503 while draining, healthy when not, healthy when streaming
  uninitialized). All pass; all 18 pre-existing tests that build `MagicMock(spec=SessionManager)`
  fixtures without the new attribute still pass unmodified (verified with the full
  `apps/stt/tests/unit/` run above).
- **TTS admin introspection (Task 4), real ASGI-test-client output** (5 providers registered with
  `FakeEngine`, no live server this session):
  ```
  == GET /api/v1/providers == 200
  {
    "providers": [
      {"name": "azure", "healthy": true, "is_configured": true, "breaker_open": false, "gpu_bound": false, "resolved_device": null},
      {"name": "sarvam", "healthy": true, "is_configured": true, "breaker_open": false, "gpu_bound": false, "resolved_device": null},
      {"name": "kokoro", "healthy": true, "is_configured": true, "breaker_open": false, "gpu_bound": true, "resolved_device": null},
      {"name": "indic_parler", "healthy": true, "is_configured": true, "breaker_open": false, "gpu_bound": true, "resolved_device": null},
      {"name": "indic_f5", "healthy": true, "is_configured": true, "breaker_open": false, "gpu_bound": true, "resolved_device": null}
    ]
  }
  ```
  (`resolved_device` is `null` here because `FakeEngine` carries no `_config` — a dedicated test,
  `test_local_provider_resolved_device_surfaced_when_present`, proves the real wiring against a
  fake `_config.device = "cuda"`.)
- **GPU/device classification (Task 5):** documented above and machine-readable via `gpu_bound` in
  the same endpoint — `kokoro`/`indic_parler`/`indic_f5` = `true`, `azure`/`sarvam` = `false`,
  covering all 5.
- **Local-dev story (Task 6), real command output:**
  ```
  $ ./scripts/dev-service.sh stt-worker --print
  service: stt-worker
    PYTHONPATH=apps/stt/src
  command:
    conda run -n arcaenv --no-capture-output env PYTHONPATH=apps/stt/src python -m dramatiq stt.worker --processes 1 --threads 4
  ```
  `python -c "import stt.worker"` (with `PYTHONPATH=apps/stt/src`) succeeds and logs the broker —
  including the new queue-depth gauge wiring — configuring cleanly with no live Redis reachable.
  Actually PROCESSING a submitted job end-to-end needs a running Redis, not up this session — that
  half is unverified beyond the hermetic `WorkerPoolQueue`-equivalent unit tests above (this
  ticket did not add a new queue/consumer for STT — `stt_batch`'s existing actor is unchanged).
- **Task 7 design note:** design-notes.md §(d)/(b); no `deployment/k8s/**` files created in this
  repo (confirmed by `git status` — none listed).

## Known gaps / residuals (honest accounting)

1. **Nothing was verified against a LIVE Redis, LIVE `stt` worker process, or LIVE `tts` service**
   — local infra was down for the entire session. All verification is hermetic (mocked
   Redis/broker/httpx) or via ASGI/FastAPI `TestClient` against the real app object (no live
   socket).
2. **`apps/stt/tests/integration/` and `apps/stt/tests/e2e/` were not run** — both require live
   Postgres/Redis/MinIO, per the HARD RULES.
3. **KEDA/HPA manifests themselves are NOT in this repo** and were not written — by design (rule
   09); the design note is the deliverable for this repo, the YAML is `arca/hope-v2-deployment`'s
   to author.
4. **The realtime-draining race window (design-notes.md §(a) step 3) is real but narrow**: between
   a failed readiness probe and the pod's actual removal from Service Endpoints, a request could in
   principle still land on a draining pod. `SessionManagerDrainingError` is the defense-in-depth
   layer for exactly that window — it is tested at the unit level, not against a real k8s Service,
   which this repo has no way to exercise.
5. **`apps/api`/`stt-ws.gateway.ts` was deliberately NOT modified** — design-notes.md §(a) argues
   this from reading the gateway file (it has no per-STT-pod routing table today), not from running
   it against a live multi-pod `stt` deployment, which this session cannot do.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
| 2026-08-16 | Design note + Tasks 2–6 implemented: STT queue-depth metric, STT realtime draining (SessionManager + `/internal/streaming/drain` + `/health/ready`), TTS admin introspection endpoint + GPU/device classification (Task 4/5 scoped down after finding TTS's circuit-breaker degrade-routing already existed), STT local-dev story re-verified (no code change needed). Task 7 flagged as deployment-repo design note only. `apps/stt` unit suite 2815/2815 green (2791 in `tests/unit/`), `apps/tts` 267/267 green, both lint clean; STT typecheck has one pre-existing unrelated error, TTS typecheck clean. No `apps/api` files touched. Status → Review. | Claude (execution session) |
