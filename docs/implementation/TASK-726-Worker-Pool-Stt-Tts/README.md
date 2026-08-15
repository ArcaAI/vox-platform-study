# TASK-726 — Worker Pool: `stt` + `tts` (Apply the TASK-725 Pattern)

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 3 · **Size** | M |
| **Epic slug** | `worker-pool-stt-tts` |
| **Depends on** | TASK-725 (`worker-pool-text` — this ticket follows its control-plane/registry/
  degrade-routing/metrics pattern; do not re-derive it independently) |
| **Design refs** | [design.md](../../architecture/agentic-workflow-platform/design.md) §Services program ("Worker-pool standard") |
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

- [ ] `pnpm stt:test` and `pnpm tts:test` — all new and existing tests pass; paste output.
- [ ] `pnpm stt:lint` / `pnpm stt:typecheck` and `pnpm tts:lint` / `pnpm tts:typecheck` — clean;
      paste output.
- [ ] `uv lock` re-run at repo root if either service's `pyproject.toml` changed.
- [ ] Queue-depth metric (Task 2) visible in STT `/metrics` output — pasted.
- [ ] Draining behavior (Task 3) covered by a test proving new sessions are rejected/rerouted while
      in-flight sessions complete — distinct from the existing crash-recovery path, which remains
      untouched and still passes its existing tests.
- [ ] TTS admin introspection endpoint (Task 4) returns per-provider health for all 5 providers —
      manual `curl` output pasted.
- [ ] GPU/device classification (Task 5) documented for all 5 TTS providers.
- [ ] `pnpm test:unit` (apps/api) passes if `stt-ws.gateway.ts` was touched by Task 3.
- [ ] Task 7's design note written into §7, scoped as deployment-repo work, no `deployment/k8s/**`
      files created in this repo.

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

(Empty at authoring — filled during execution.)

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Claude (ticket-authoring session) |
