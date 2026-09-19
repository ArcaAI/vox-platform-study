# D6 — Serving, GPU & Lifecycle: design dossier for TASK-985

Area author: D6. Scope: QW-4/M-17 (cold start), M-26 (concurrency), M-51 (CUDA arch),
M-52/M-59/M-60 (worker processes, memory, stale docs), QW-6 (CI scoping), ST-8/OD-G
(GPU sharing), the liveness gap TASK-990 leaves open, and the D6 test plan. No code
written — this is a design for follow-up tickets to implement.

Coordination note: TASK-990 owns `deployment/k8s/base/stt.yaml` probes/preStop/
`terminationGracePeriodSeconds`, `apps/stt/src/stt/health/api/routes.py`,
`apps/stt/src/stt/core/middleware/auth.py`, and `apps/stt/src/stt/worker.py` in full,
and per the brief is landing a `/health/startup` route that deliberately does not gate
on model residency. Everything below is designed to compose with that surface, not
duplicate it — where a change belongs in one of those four files, this dossier states
the requirement and leaves the edit to that lane.

---

## 1. QW-4 / M-17 — cold start

### 1.1 What the evidence establishes

- Cluster (Loki, 14 d window read on 2026-09-17): ten `reason=ttl` evictions, each
  followed 7–10 s later by a `201` session create — i.e. ten cold reloads landed on a
  live clinician in that window alone.
- Local (2026-09-18): eviction at `00:42:33.34` (`stt_model_cache.evicted … reason=ttl`),
  cold reload `00:42:34.36`→`00:42:38.99` (~4.6 s), inside a `durationMs=5807`
  session-create POST — against `118 ms` and `224 ms` for the two warm creates in the
  same run. That is a ~25–45x latency multiplier on "Start recording" for exactly the
  sessions that follow a quiet stretch, which is most of them (a consultation is
  typically longer than the 600 s TTL apart from the previous one).
- Cluster runbook corroborates the SAME failure shape as a *documented, repeatable*
  defect independent of this ticket: `hope-v2-deployment/docs/deployment-runbook.md:842-849`
  — "The first STT session after a GPU pod rolls is 503 … the STT pod's log shows the
  session created 16.4 s after the request. The gateway's `StreamingSessionService`
  waits 15 s … **The session is then reconciled as a leaked slot**." That last clause is
  the same code path as the run-log observation in TASK-985 §2.3 ("the capacity
  reconciler released the in-creation session's slot during the cold load") — see §9.1
  below, this is not a one-off, it is a standing interaction between cold start and the
  capacity guard.

### 1.2 The three QW-4 sub-changes, and why each is the right tier

**(a) `stt.modelCache.ttlSeconds` SYSTEM-tier write, now.**

The served TTL today is **600 s**, not the 3600 s a careless read of the code would
suggest:

- `apps/stt/src/stt/core/config/settings.py:270-278` — the Python field's own
  bootstrap default is `3600`, clamped `ge=60, le=3600`. This is the value in force
  ONLY if the control plane is unreachable at boot (the comment there says so
  explicitly: "Bootstrap fallback — the runtime value comes from the control plane").
- `packages/applications/.../descriptors/service-runtime.descriptors.ts:41` —
  `SERVICE_RUNTIME_DEFAULTS['stt.modelCache.ttlSeconds'] = 600`. This is the value the
  registry serves when no `GlobalSetting` row exists (open-to-default fail mode), and
  there is no seeded row (`grep` of `packages/database/.../seed/` for the key returns
  nothing) — so **600 is what actually reaches the running process** via
  `refresh_settings_from_control_plane()` at boot (`main.py:132-137`) and
  `_refresh_retention()` on every `get_or_load` (`stt/models/cache.py:541-545`).
- This is a genuine drift worth fixing regardless of QW-4 (see §9.2): the file's own
  header comment (`service-runtime.descriptors.ts:15`, "verified 2026-07-20") states
  the Python default as the source of truth ("= 3600 … clamp ge=60 le=3600") and then
  the same file registers a DIFFERENT served default (600) two sections later with no
  comment explaining the divergence.

The fix is a **SYSTEM-tenant `GlobalSetting` row**, not an env var and not a code
change to the registered default:
- It is exactly the "tenant → SYSTEM, env is the bootstrap floor only" rule
  (`00-project-context.md` §Configuration Principles) — TTL is a runtime-tunable
  retention knob, not a bootstrap transport address.
- It is a **platform-wide** value (no tenant runs its own STT pod), so it belongs on
  the SYSTEM tenant, written once, propagated by the existing invalidation channel
  (`app-settings:invalidate` — `09-infrastructure-devops.md` §Config caches) rather
  than a redeploy.
- Recommended value: **3600** (the clamp ceiling, and what the Python field's own
  comment already documents as the intended steady-state). This alone removes 100% of
  the TTL-driven evictions observed in the 14-day Loki window, at the cost of holding
  one whisper.cpp model resident (this is a single-model-family service; §1.2(b) below
  bounds the memory cost). This is a DB write, ships independent of everything else in
  this dossier, and is the cheapest available fix for the ten-eviction cluster evidence
  — it should not wait on OD-F.

**(b) `memory_size_mb` on the whisper.cpp `AiModel` rows — ALREADY DONE; verify, don't
re-implement.**

**Correction (2026-09-19): my first pass checked the wrong file** — I grepped
`packages/database/src/prisma/db_main/seed/06-ai-models.ts`, which is the generic
mapping/loader (`memorySizeMb: modelData.memorySizeMb` pass-through at its line 91),
and wrongly read the absence of a literal there as the field being unset everywhere.
The literal values live one level down, in
`packages/database/src/prisma/db_main/seed/ai-models/audio.ts`, which the loader reads
`modelData` from — and they ARE populated, for every whisper.cpp row this service
serves:

| Slug | `memorySizeMb` | `audio.ts` line |
|---|---|---|
| `arcaai-whisper-large-ml-en-gguf` (f16 — serves every live consultation today) | 1700 | 123 |
| `arcaai-whisper-large-ml-en-gguf-q8_0` | 900 | 167 |
| `arcaai-whisper-large-ml-en` (transformers/pytorch) | 3584 | 204 |
| `arcaai-whisper-large-ml-en-ct2` | 3000 | 229 |
| `whisper-large-en-medical-260726-merged-gguf` (f16) | 1700 | 256 |
| `whisper-large-en-medical-260726-merged-gguf-q8_0` | **1700** | 295 |
| `whisper-large-en-medical-260726-merged-ct2` | 3000 | 331 |

Confirmed independently against the live dev DB (`core."AiModel"`), which carries the
same seven values. So `apps/stt/src/stt/models/cache.py:550`'s pre-load pressure-relief
budget (`_memory_estimates.setdefault(slug, model_config.memory_size_mb or 0)`) is
**not** running blind for these rows — my original claim was wrong, and QW-4's
"set `memory_size_mb` on the whisper.cpp model rows" sub-item is **already satisfied**.
There is nothing here for an implementer to do; do not re-open this as a seed edit.
One consequence for OD-F (§1.3): warm-on-boot's pre-flight budget check
("does the SYSTEM-default model fit inside `stt.modelCache.maxMemoryMb`") already has
the honest estimate it needs for the row that matters
(`arcaai-whisper-large-ml-en-gguf`, 1700 MB) — this is one fewer prerequisite for OD-F,
not one more.

**New defect found while re-verifying (see §9 for the full entry): the medical q8_0
row's `memorySizeMb` looks copy-pasted from its f16 sibling.** The ml-en pair shows the
expected quantization ratio — f16 1700 MB vs q8_0 900 MB (~53%, consistent with 8-bit
vs 16-bit). The medical pair does not: `whisper-large-en-medical-260726-merged-gguf`
(f16) is 1700 MB (`audio.ts:256`) and
`whisper-large-en-medical-260726-merged-gguf-q8_0` is ALSO 1700 MB
(`audio.ts:295`) — identical to its f16 sibling, where the ml-en pattern predicts
roughly 850–900. This over-reserves pre-load budget for exactly the row an operator
would pick to save memory. This is the contract/data-seed lane's file, not mine — flag
only, do not edit `audio.ts` from here.

**(c) `flash_attn` and `audio_ctx` as row-level runtime options.**

- `apps/stt/docker/Dockerfile:206-208` already best-effort-installs a `flash-attn`
  wheel at BUILD time ("skip if unavailable"); `whisper_cpp_loader.py:96` and
  `whisper_cpp_asr.py:99,381` (per the README) refuse it at RUN time on Ada
  (`flash_attn` off on Ada — a per-session WARNING for a refusal the seed itself
  chose, per M-62). `audio_ctx` is not currently passed anywhere in the adapter's
  `whisper_full_params` construction.
- Both belong on `AiModel._metadata.asr.decoding` (or the model row's `_metadata.asr`
  block generally) alongside `maxDecodeWindowSec`/`hotwordsInPrompt` — i.e. the SAME
  place TASK-946's `hotwordsInPrompt` landed, following the established "per-model
  runtime option travels with the row, not a service-wide `stt.whisperCpp.*` knob"
  pattern already used for the decode window (`whisper_cpp_asr.py:432-464`, "the
  window then travels with the CALL rather than with the adapter instance").
- These are throughput levers, not cold-start levers per se (F9-D4: `audio_ctx` 768
  floor ~2x faster encode for a 7 s span; F9-D5: flash attention >= 1.25x). I keep them
  in QW-4 only because the ticket groups them there; they should be MEASURED (row-level
  A/B, not shipped as a default change) before any seed write — this is explicitly a
  Wave-1 "measure first" item per the ticket's own framing, and belongs behind BP-1's
  re-captured baseline so the A/B isn't confounded by the six already-known served-vs-
  measured deltas in §2.2 of the parent review.

### 1.3 OD-F — warm-on-boot design

**Recommendation: yes, as a governed default-OFF key**, landed strictly AFTER 1.2(a)
and 1.2(b), because the TTL write alone removes the recurring mid-shift cold start and
buys time to design warm-on-boot without urgency.

**Key**: `stt.warmDefaultAsrOnBoot` (boolean, SYSTEM-tier, default `false`,
`failMode: open-to-default` — this is a tuning/availability knob, not a
selection/credential, so an unresolved value should leave today's lazy-load behaviour
in force rather than raising).

**Mechanism — reuse the pattern that already exists, do not invent a second one.**
`main.py:177-191` already has EXACTLY this shape for the cache-root filesystem warm:
a detached `asyncio.create_task`, fired after the infra block, explicitly documented as
"must not delay or fail boot." Warm-on-boot for the actual ASR model extends this same
task, gated by the new key:

1. After `refresh_settings_from_control_plane()` returns (so the key's SYSTEM value is
   already known — `main.py:132-137`), if `stt.warmDefaultAsrOnBoot` is true: resolve
   the SYSTEM-assigned default ASR spec (the same resolution the gateway's
   `AsrAgentResolverService` would produce for a tenant with no department override —
   or, more simply, whichever model slug the SYSTEM `Agent` for `SPEECH_TO_TEXT`
   currently binds, since a boot-time warm cannot be tenant-scoped and has no session
   context to resolve against).
2. Fire `get_model_cache().get_or_load(...)` for that one slug inside a DETACHED task
   (`app.state.model_warmup_task`), same non-blocking contract as the existing
   `model_cache_warmup_task`: never awaited by `lifespan`, cancelled on shutdown,
   exceptions logged and swallowed (never raised into boot).
3. Do **not** gate `/health/startup` on this task's completion. Per the brief,
   `/health/startup` deliberately does not gate on residency, and that is the correct
   boundary: `startupProbe` governs "is the process up and are its hard infra deps
   reachable" (DB/Redis/MinIO/bucket-mount, per the existing `/health/ready` checks at
   `apps/stt/src/stt/health/api/routes.py:112-131`). If warm-on-boot instead blocked
   startup, a slow model load (network-backed s3fs read) or a broken load (bad digest,
   corrupt GGUF) would turn a routine model swap into a `CrashLoopBackOff` that kills
   ALL serving capacity — a strictly worse failure mode than today's per-session cold
   penalty. This is the same reasoning the existing cache-root warm task already
   documents ("warming can make the first probe faster, never slower, and it must not
   delay or fail boot" — `main.py:181-183`); warm-on-boot for the model inherits it
   verbatim.
4. **Readiness on residency is a SEPARATE, later change and belongs to whoever next
   owns `/health/ready`** (TASK-990's file). The requirement to hand off: when
   `stt.warmDefaultAsrOnBoot=true`, `/health/ready` should additionally fail (bounded —
   see below) until the warm task reports the model resident, OR until a timeout
   elapses (e.g. 60 s), after which readiness reports healthy anyway so a broken warm
   never permanently seals off a pod that is otherwise fully capable of lazy-loading
   the model on first request. Unbounded gating on residency would reintroduce the
   startup-blocking failure mode one layer up (`/health/ready`'s own
   `failureThreshold * periodSeconds` window would eventually crash-loop the pod on a
   load that never finishes) — the bound is not optional.
5. Interaction with TASK-990's `preStop`/drain path: warm-on-boot has NO interaction
   with draining — it only ever runs once, at boot, before the pod is marked
   `is_draining`. No coordination needed there.
6. Interaction with STT's intentional lazy load of aux models (Silero VAD, Pyannote
   embedding, Cadence punctuation — `main.py:149-152`): warm-on-boot touches ONLY the
   ASR model slug. It must not be generalized to "warm everything the SYSTEM agent
   might reference" — those three are deliberately lazy per their own idempotent
   per-use guards, and the rationale for keeping them lazy (most tenants/sessions never
   touch diarization or embedding) is orthogonal to the ASR cold-start problem this
   item targets. Scope creep here would reintroduce the exact 9.3 s dead-import cost
   TASK-944 fixed for the speaker-embedding path (Dockerfile:238-248) at boot instead
   of on first use.

**Why default OFF and not ON**: this is the standing pattern for anything that changes
resource commitment at boot without a measured production baseline (per
`09-infrastructure-devops.md`'s `failMode` split — this is a tuning knob, open-to-
default, but "open" still means "off until an operator turns it on"). It also lets
1.2(a)'s TTL write ship and be observed in isolation before a second variable (a
resident model occupying VRAM for the pod's entire lifetime) is added.

---

## 2. M-26 — concurrency

### 2.1 Confirmed mechanism

- `apps/stt/src/stt/streaming/whisper_cpp_asr.py:395-429` — one process-wide
  `threading.Lock` **per `model_id`** (`_get_model_lock`, module-level dict at
  `whisper_cpp_asr.py:126-127,202-208`), shared across every session and adapter
  instance bound to the same loaded model. `__call__` (`:432-464`) holds this lock for
  the ENTIRE `_decode_spans_locked` call — every span of one final or one partial.
- `apps/stt/src/stt/streaming/execution_profile.py:203-207` — the RTX-A2000-shaped
  profile (the closest match to the cluster's RTX 2000 Ada) declares
  `max_concurrent_streams=20`. This is what the capacity guard admits against
  (`stt.streaming.maxConcurrent` registry default is `0` = "hardware auto-detect" per
  `service-runtime.descriptors.ts:47,232-236` — so 20 is not a governed ceiling today,
  it is a hardware-profile literal).
- `session_manager.py`'s partial-fire path (`_fire_partial`, ~3145-3180) is
  skip-if-busy per session (one partial task in flight at a time PER SESSION) but
  every session's partial and final decodes still serialize against every OTHER
  session's decodes on the shared per-model lock. With N sessions each firing a
  partial every `partialIntervalMs` (served: 300 ms) plus finals on endpoint cuts, the
  lock is a single FIFO queue for the whole pod's GPU-bound decode work — admission
  (20) and throughput (bounded by 1/mean-decode-latency) are two different numbers,
  and nothing on record today measures the second one.

### 2.2 Design: lock-wait histogram

- Instrument at the ACQUISITION site, not the call site: wrap `with self._lock:` at
  `whisper_cpp_asr.py:465` with a `time.monotonic()` delta recorded before/after
  acquisition (not around the whole `__call__`, which conflates queueing time with
  decode time — the two need to be separable to answer "is this session slow because
  it's waiting, or because the decode itself is slow").
- Metric: `stt_streaming_lock_wait_seconds` histogram, labels `{model_id, kind}` where
  `kind ∈ {partial, final}` (the adapter already knows this from its caller — thread
  the label through `__call__`'s existing `prompt`/`max_decode_window_sec` kwargs
  rather than inferring it from context). Buckets should cover the served
  `partialIntervalMs` (300 ms) up through `maxDecodeWindowSec` (7 s) so p50/p95/p99 can
  be read directly against the cadence that would make a partial arrive late.
- This is the BP-5 observability item's natural home for this one series (BP-5 already
  asks for `inferenceMs` and engine-labeled inference latency; lock-wait is the missing
  companion metric that turns "inference is slow" into "inference is slow because it's
  QUEUED" vs "the decode itself got slow").

### 2.3 Design: finals-before-partials priority

- Today `_fire_partial`'s `_run_partial` (session_manager.py ~3163-3168) already waits
  up to 2 s on a per-session `_final_published_gates` event before firing ITS OWN
  partial, so a session does not race its own final. There is no equivalent PRIORITY
  between DIFFERENT sessions contending for the shared lock — a partial for session A
  and a final for session B queue on the same `threading.Lock` in acquisition order
  (FIFO under CPython's `Lock`), so a burst of partials from busy sessions can delay
  another session's FINAL, which is the artifact a clinician actually reads back later
  (a delayed partial is invisible; a delayed final is a stalled caption).
- Design: replace the bare `threading.Lock` per model with a small priority gate —
  two `asyncio`-visible queues (or a `threading.Condition` with a priority counter) so
  a FINAL decode request queued behind in-flight PARTIALS gets served next, ahead of
  any partial that arrived after it. Concretely: a bounded structure per model_id with
  `acquire(kind: Literal["partial","final"])` that grants finals before partials
  whenever both are waiting, and preserves FIFO within the same kind (so finals don't
  starve each other, and a burst of same-priority partials still round-robins fairly).
  This must stay a plain-Python primitive usable from the synchronous
  `_decode_spans_locked` call site (which runs inside `asyncio.to_thread`,
  `session_manager.py:2556-2562`) — no asyncio primitives cross the thread boundary
  cleanly, so this is a `threading`-native structure, not an `asyncio.Lock`.
- Cheaper fallback if the priority gate is judged too invasive for a first cut: keep
  the single lock, but have `_fire_partial` SKIP firing a partial (not just skip-if-
  busy on its own prior partial) whenever the lock-wait histogram's recent p95 exceeds
  a bound — i.e., back off partial cadence under contention rather than adding
  priority. This is strictly weaker (does not protect an in-flight final from a
  partial that started just before it) but needs no new synchronization primitive.
  Recommend the priority gate; note the fallback exists if BP-6's numbers show
  contention is rare enough that it isn't worth the complexity.

### 2.4 Design: deriving `stt.streaming.maxConcurrent` from the measured curve

- The ticket's BP-6 (below, §8) is the source of truth: WS harness at N = 1, 2, 3, 4, 6
  concurrent sessions against the SAME served agent/geometry, on the cluster (CUDA —
  MPS numbers are local-only and must never be promoted to this decision per the
  parent review's "Environment control" rule).
- Decision rule (already stated in the ticket, restated here for the write path): set
  `stt.streaming.maxConcurrent` (SYSTEM-tier `GlobalSetting`, registry key already
  exists at `service-runtime.descriptors.ts:44,229-231`) to the **largest N whose
  commit p50 is within 1.4x of the N=1 commit p50**, provided inference p95 at that N
  stays under 1 s (the ticket's own BP-6 acceptance bar). This REPLACES the hardware-
  profile literal (`execution_profile.py:207`, `max_concurrent_streams=20`) as the
  effective ceiling once written — the profile value stays as the bootstrap fallback
  (env/hardware-detected, per the two-tier rule), the DB row is what a platform admin
  can retune without a redeploy once the curve is known.
- This is explicitly NOT something to guess ahead of BP-6 — 20 is admission-cap-shaped
  ("what fits in GPU memory / what the profile author guessed"), not throughput-shaped,
  and this dossier does not recommend a number.

---

## 3. M-51 — CUDA arch

### 3.1 Confirmed

- `apps/stt/docker/Dockerfile:274-291,299` — `CMAKE_CUDA_ARCHITECTURES=89` (Ada
  Lovelace only: RTX 2000 Ada / A2000 Ada / L4 / 4090). The comment at lines 274-278
  already documents that this MUST be updated "with the deploy GPU" — i.e. the
  Dockerfile itself flags this as a single-target pin that needs maintenance, it just
  hasn't been widened yet.
- `hope-v2-deployment/deployment/k8s/eks/**` (read, not edited — EKS is `EKS templates
  live in eks/` per prior TASK work): the AWS plan's `g5` instance family serves
  **A10G**, which is **sm_86**, not sm_89. A `stt-ml-runtime`/`stt-worker` image built
  today and deployed onto a `g5` node would run pywhispercpp's CUDA backend with ZERO
  matching kernels for the card it is actually on.
- The Dockerfile already has a real build-time CUDA-link gate (`Dockerfile:304-320`):
  it asserts the extension links `libcudart`/`libcublas` and does NOT retain a dangling
  `libwhisper.so` reference. This gate proves the extension was compiled WITH CUDA
  support and links against the right runtime libraries — it does **not** prove the
  compiled kernels match the arch of the GPU the container eventually runs on, because
  that check happens at build time on the CI runner's toolchain, before the image ever
  reaches a node.

### 3.2 What "wrong arch" looks like today — established from upstream behavior, not observed on this cluster

Per the parent review's own citation of upstream behavior (`Dockerfile:262-267`,
already documented in-repo for the PyPI-wheel case): "whisper.cpp does NOT error when
asked for a GPU it wasn't compiled for — it logs `use gpu = 1` and silently decodes on
the CPU thread pool." The same silent-CPU-fallback behavior is the documented failure
mode for a CUDA arch mismatch in a SOURCE build too (ggml's CUDA backend either finds
no matching cubin/PTX for the running SM version and falls back, or — depending on the
specific ggml/driver JIT-compile path — the kernel launch aborts with a CUDA error that
surfaces as an unhandled exception inside the synchronous decode call, i.e. inside the
`with self._lock:` block in `whisper_cpp_asr.py:465`). Two different observable
outcomes are both plausible from the same root cause, and BOTH are compatible with
readiness staying green:

- **Silent CPU decode**: `/api/v1/health` and `/health/ready` never touch the ASR
  adapter, so they report healthy. Every session works, RTF quietly explodes (CPU
  decode of a model sized for GPU is an order of magnitude slower), and the only
  visible symptom is latency — which per M-03/M-21 has NO dashboard or alert on this
  path today. This is the worse of the two outcomes because it is silent AND slow.
- **Launch abort**: `whisper_full`'s return is discarded by pywhispercpp today per
  M-24 (`whisper_cpp_asr.py:36,547` — failures return `[]` instead of raising), so an
  aborted kernel launch on this codepath likely surfaces as an EMPTY decode result
  rather than a raised exception, which the existing hallucination/empty-result
  handling would treat as "no speech," not as an engine failure — compounding with
  M-24's already-identified defect (the fallback chain never arms because nothing
  raises `ModelError`).

Recommendation: an explicit load-time assertion (see §3.3) is the only way to convert
either silent failure mode into a loud one, and it should ship BEFORE any g5/A10G
deployment is attempted, not after.

### 3.3 Design

**(a) Multi-arch build ARG.**
```
ARG CUDA_ARCHITECTURES=86-real;89-real;89-virtual
```
passed through the existing `CMAKE_ARGS` construction at `Dockerfile:298-299`,
replacing the literal `89`. The `-real` suffix compiles native SASS for exactly that
SM version (fast, no JIT); `89-virtual` additionally embeds PTX for sm_89 so a driver
newer than the build can JIT-recompile forward-compatibly, which is the standard
CMAKE_CUDA_ARCHITECTURES idiom for "support these exact cards, stay forward-compatible
on the newest one." `86-real` (no `-virtual` needed for 86 since it is not this
fleet's forward-compat target) covers the A10G in the EKS plan. This is a
**build-time** change only — CI already builds one image per pipeline for the current
cluster; multi-arch here means one image works on EITHER card family, not that CI
builds two images. Image size cost is small (a few extra cubins in the static-linked
`_pywhispercpp*.so`); this is the standard, low-risk way to widen a CUDA arch pin.

**(b) Load-time CUDA-backend assertion.**
Today nothing in `stt.models.whisper_cpp_loader` or `WhisperCppAsrAdapter.__init__`
confirms the loaded `Model` actually initialized its CUDA backend versus silently
falling back to CPU. whisper.cpp/pywhispercpp write a log line identifying which
backend it initialized (ggml prints something to the effect of "ggml_cuda_init: found
N CUDA devices" / a per-backend init trace during model load — the parent review's
`_ensure_log_capture_installed()` at `whisper_cpp_asr.py` already captures whisper.cpp's
native log output into structured logging, which is the existing hook this assertion
should use). Design:
1. After `Model(...)` construction in the loader, inspect the captured log lines from
   the load for a line matching the CUDA backend init marker (or, if pywhispercpp
   exposes it, a queryable backend/device attribute on the loaded context — check the
   pinned `v1.5.0` API before committing to log-scraping as the only mechanism).
2. If the row's declared `AiModelConfig` requests a GPU device (`asr_device` /
   `execution_profile.asr_device` resolves to `cuda:N`) and the load did NOT confirm a
   CUDA backend, raise a named `ModelLoadError` ("whisper.cpp loaded on CPU: no CUDA
   backend confirmed for a GPU-declared model — check `CMAKE_CUDA_ARCHITECTURES`
   against this node's compute capability") rather than letting the adapter serve
   silently degraded. This is a FAIL-CLOSED outcome for a provider/engine-selection-
   shaped failure (matches `failMode: closed` for selection, per the config-tiers
   rule), not a tuning knob that should degrade quietly.
3. This assertion belongs in the loader/adapter construction path
   (`apps/stt/src/stt/models/whisper_cpp_loader.py` and/or
   `WhisperCppAsrAdapter.__init__`, `whisper_cpp_asr.py:395-429`), i.e. it fires once
   per model LOAD, not once per decode call — cheap, and it converts a cold-start-time
   failure into a cold-start-time error instead of a per-session latency mystery.
4. Interacts with M-24 (fallback chain never arms because nothing raises on a bad
   decode): this assertion is a DIFFERENT, earlier gate — it fires at LOAD time, before
   any session ever reaches the adapter, so it should raise straight into the existing
   model-load error path (surfacing as a 5xx on the session-create call, or arming the
   fallback chain if M-24's fix lands first), not wait for M-24 to also land. The two
   fixes are complementary, not sequenced.

---

## 4. M-52 / M-59 / M-60

### 4.1 M-52 — worker `--processes 1`

- `apps/stt/docker/Dockerfile:474` — `CMD [...,"dramatiq","stt.worker","--processes",
  "2","--threads","4"]`. This is a plain image-baked literal; nothing governs it.
- Two Dramatiq processes means two separate CUDA contexts and two separate whisper.cpp
  model caches inside the SAME pod, contending for the SAME GPU slice(s) the realtime
  streaming pod also shares (`06-python-services.md`'s peer-client-and-shared-GPU
  posture, and this ticket's GPU-budget arithmetic in §6 below — the worker's GPU
  request is its OWN allocated unit, but the underlying physical card is still
  time-sliced against STT's realtime unit AND, depending on scheduling, LM Studio's
  units on the SAME card).
- Design: derive the process count from a governed worker descriptor —
  `stt.workers.concurrency` already exists as a registry key
  (`service-runtime.descriptors.ts:14,42,233-236`, default `4`, currently documented as
  Dramatiq worker CONCURRENCY, i.e. threads-per-process, not process count). Two
  options, in order of preference:
  1. **Simplest, matches the recommendation verbatim**: change the CMD's `--processes`
     literal from `2` to `1` directly (this alone removes the double-CUDA-context
     problem; `--threads 4` can stay, or be re-derived from
     `stt.workers.concurrency` separately). This is the change QW-6/M-52 asks for and
     is the minimal fix.
  2. **More correct long-term, more invasive**: read `--processes` from an entrypoint
     wrapper that queries the effective-config value at container start (the same
     shape `_configure_torch_threading` already uses to prefer an env/settings value
     over a hardcoded guess, `main.py:37-53`), so a platform admin can retune worker
     parallelism without a rebuild. This requires Dramatiq's CLI to be wrapped in a
     small shell/Python launcher rather than invoked directly as the image CMD — a
     larger change than this ticket's Wave-2 framing intends. Recommend (1) now,
     leave (2) as a Wave-3-shaped follow-up if operators actually need to retune
     worker parallelism live (no evidence on record that they do).
- Either way, the GOAL is one CUDA context in the worker regardless of code path: a
  literal `--processes 1` reaches that goal exactly as well as a governed read of a
  value that would also resolve to `1`, and is far cheaper to ship.

### 4.2 M-59 — memory request/limit vs measured peak

- `hope-v2-deployment/deployment/k8s/base/stt.yaml:337-344` — requests `cpu:"2"`,
  `memory:"8Gi"`, `nvidia.com/gpu:"1"`; limits `cpu:"8"`, `memory:"24Gi"`,
  `nvidia.com/gpu:"1"`.
- 14-day Prometheus peak cited by the parent review: 1.19/1.95 GiB (presumably
  request-window RSS peak / limit-window peak, read from the cluster). Both request
  and limit are 4–8x that peak.
- Design: this is a **cluster-config change** (`deployment/k8s/base/stt.yaml`
  `resources` block), out of scope for THIS repo's code but in scope for THIS
  dossier's recommendation to the deployment-repo owner: right-size to roughly
  `memory: "3Gi"` request / `"12Gi"` limit — still ~1.5–2.5x the measured 14-day peak
  (healthy headroom for a model swap or a burst of concurrent sessions holding
  multiple pinned models at once), freeing ~5Gi of request against the node's shared
  budget. Recommend gating this on "one more clinic week" of data as the parent
  review's Wave framing already states, rather than shipping off a single 14-day
  sample — a memory request cut that later OOM-kills the pod mid-consultation is a
  strictly worse outcome than the current over-provisioning.
- **VRAM has no reservation or alert at all** — this is the sharper gap. Unlike CPU/
  RAM, `nvidia.com/gpu: "1"` is a COUNT of time-sliced units, not a memory reservation;
  time-slicing (confirmed live, not MIG — `hope-v2-deployment/deployment/k8s/base/
  gpu-time-slicing.yaml`, `sharing.timeSlicing.resources[0].replicas: 3`) gives NO
  memory isolation between pods sharing a physical card (the runbook says this
  explicitly: "Time-slicing gives no memory isolation between pods sharing a card; a
  CUDA OOM in one can affect its neighbour" — `docs/deployment-runbook.md:281-282`).
  Design: a DCGM `FB` (framebuffer) utilization alert at >85% sustained, scoped to the
  node (DCGM is already scraped per the parent review's M-21, "DCGM is scraped but
  never joined" — this is the join). This is a BP-5/observability-shaped deliverable,
  not a resources-block change, and it is the closest available proxy for "an STT/LM
  Studio/vLLM neighbour is about to OOM the card out from under a live PHI session,"
  since no per-pod VRAM request/limit mechanism exists on time-sliced GPUs today.

### 4.3 M-60 — three stale documentation passages, verified precisely

All three describe the pre-TASK-855 hostPath-cache deployment shape; TASK-855 moved
weight delivery to the s3fs bucket sidecar. Verified against the CURRENT
`hope-v2-deployment` checkout (not the README's snapshot):

1. **`apps/stt/docker/Dockerfile:440-449`** (the comment block explaining why the
   image's `HF_HOME=/models/hf-cache` is inert in the cluster) still says: "the
   deployed Deployment … sets HOME=/home/hope, HF_HOME=/home/hope/.cache/huggingface
   and HUGGINGFACE_CACHE_DIR=/home/hope/.cache/huggingface/hub, and mounts the
   persistent `models-cache` hostPath at that hub path." **This is no longer what the
   manifest does.** The CURRENT `deployment/k8s/base/stt.yaml` (read directly, lines
   ~245-278) sets `HF_HOME=/mnt/models-bucket/hf`, `HF_HUB_CACHE=/mnt/models-bucket/hf/
   hub`, `HUGGINGFACE_CACHE_DIR=/mnt/models-bucket/hf/hub`, `HF_HUB_OFFLINE=1`, backed
   by the s3fs sidecar mount (`models-bucket` emptyDir + `HostToContainer` propagation,
   NOT a `models-cache` hostPath — there is no `models-cache` volume in this file at
   all). An engineer following the Dockerfile comment during an outage would look for
   a hostPath that no longer exists.
2. **`apps/stt/tests/test_hf_home_manifest_divergence_task817.py`** pins the SAME
   stale fact as an executable assertion: `MANIFEST_HF_HOME =
   "/home/hope/.cache/huggingface"` (line 44), and its docstring (lines 1-37, dated
   "verified 2026-08-28") describes the retired hostPath shape in full, including a
   `models-cache` `volumeMounts` snippet that no longer appears in `stt.yaml`. The test
   currently PASSES only because it asserts the Dockerfile CONTAINS this stale string
   — both artifacts agree with each other and are both wrong, so the test provides
   zero signal that the Dockerfile's cluster-divergence documentation is actually
   correct. This is worse than an unguarded stale comment: it LOOKS verified.
3. **`hope-v2-deployment/docs/deployment-runbook.md:849-851`** — "Retry once — every
   later session is sub-second. If it recurs, the model is being reloaded per session,
   which is a different bug." This passage frames the cold-start 503 as a ONE-TIME,
   pod-roll-only event. It is not: M-17's ten `reason=ttl` evictions in a single
   14-day window are exactly "it recurs" — driven by the 600 s idle TTL (§1.2(a)), not
   by a bug in session reuse. An operator following this runbook entry during a
   TTL-driven recurrence would go looking for "the model being reloaded per session"
   as a distinct defect, when the actual cause (idle eviction between consultations)
   is already fully characterized by this ticket.

**Fixes** (three small, independent doc edits — out of THIS repo's write scope for the
deployment-repo file, in scope to describe here):
- Dockerfile comment: rewrite to describe the s3fs bucket mount and its real env vars,
  citing `HF_HUB_OFFLINE=1` as the download-forbidding line (the comment already
  explains the OFFLINE/HOME split correctly elsewhere in the same file at
  `stt.yaml:245-268` were it to be cross-checked — the drift is specifically the STALE
  path strings, not a misunderstanding of the mechanism).
- Test: update `MANIFEST_HF_HOME` to `/mnt/models-bucket/hf` (or extend the test to
  assert BOTH the bucket path is present AND the retired hostPath string is ABSENT, so
  a future re-introduction of a hostPath default is caught the same way the original
  divergence was).
- Runbook: replace "every later session is sub-second" with an explicit cross-
  reference to the TTL behavior ("recurs whenever the model has been idle past
  `stt.modelCache.ttlSeconds`; see TASK-985 M-17 / QW-4"), removing the implication
  that recurrence indicates a session-reuse bug.

---

## 5. QW-6 — CI scoping

### 5.1 Confirmed

- `.gitlab/ci/build.yml:486-527` — `build-stt` and `build-stt-worker` both `extends:
  .build-template` and use ONLY `.build-common-rules` (`build.yml:28-32`), which reads:
  `when: never` for `merge_request`/`main`/`feature`/`release_sdk`/`prod` pipeline
  types, and runs UNCONDITIONALLY (no `changes:`) for `dev`/`staging`/`cicd`. Since
  the dev chain (`09-infrastructure-devops.md` §"The dev chain, verified end to end")
  is `push (dev-2.2) → GitLab CI pipeline (PIPELINE_TYPE=dev)`, **every push to
  dev-2.2 rebuilds both STT images**, regardless of whether `apps/stt/**` changed.
- `promote-dev` then resolves the freshly built image to a digest and commits it to
  the deployment repo (`09-infrastructure-devops.md` §Promotion), which Argo syncs —
  so every dev push produces a NEW `hope-stt`/`hope-stt-worker` digest, which is a new
  pod template hash, which is a rolling update, regardless of relevance.
- **Important nuance found during verification**: `.gitlab/ci/rules.yml:166-178`
  (`.rules-stt`, what `test-stt` actually uses) has the SAME shape — its
  `merge_request_event` branch has a `changes: apps/stt/**/*` filter, but its
  `PIPELINE_TYPE == "dev"` branch is ALSO unconditional. So simply copying
  `.rules-stt` onto `build-stt`/`build-stt-worker` would NOT fix the problem QW-6
  names — it would just make the build rule match the test rule, and the test rule is
  unconditional on `dev` too. The fix has to ADD a `changes:` filter to the `dev`
  branch specifically, which does not exist anywhere in this rule family today.

### 5.2 Design

Add an explicit `changes:` clause to the `PIPELINE_TYPE == "dev"` (and, for symmetry,
`staging`) branch of `build-stt` / `build-stt-worker`'s own `rules:` (do NOT touch
`.rules-stt` itself — `test-stt` running on every dev push is comparatively cheap and
UNRELATED to pod disruption; only the BUILD jobs need scoping, because only a build
produces a new digest that `promote-dev` can roll out):

```yaml
rules:
  - !reference [.build-common-rules, rules]   # keeps the never-on-MR/main/feature/prod gate
  - if: $PIPELINE_TYPE == "dev" || $PIPELINE_TYPE == "staging" || $PIPELINE_TYPE == "cicd"
    changes:
      - apps/stt/**/*
      - packages/py-runtime-models/**/*
      - packages/py-env/**/*
      - packages/py-otel/**/*
      - packages/py-obs/**/*
      - infrastructure/docker/python-base/**/*
      - pyproject.toml
      - uv.lock
  - if: $CI_COMMIT_TAG =~ /^STT-/ || $CI_COMMIT_TAG =~ /^ALL-/
```

The extra paths matter: the Dockerfile copies `packages/py-runtime-models`, `py-env`,
`py-otel`, `py-obs` and the root `pyproject.toml`/`uv.lock` INTO both build stages
(`Dockerfile:53-71,147-157`), and `hope-python-base` changes flow through
`BASE_IMAGE`/`warm-up-base-images`. A `changes:` filter that only watched `apps/stt/**`
would silently stop rebuilding STT on a shared-package bump that DOES affect its
image — reintroducing a different, quieter version of the same problem (a stale image
that should have rebuilt but didn't, rather than one that rebuilds when it needn't).
This exact shared-workspace-path pattern already exists in `.rules-stt`'s sibling
entries for other services in `rules.yml` (e.g. the `packages/stt/**` paths at
`rules.yml:114,123,142,154` for whatever consumes that package) — follow the same
shape, scoped to STT's actual dependency set as enumerated above.

`build-stt-worker`'s `needs: build-stt` (artifacts:false) ordering edge is unaffected —
if `build-stt` is skipped by the new `changes:` rule, `build-stt-worker`'s own
identical `changes:` clause independently decides whether it runs (both must carry the
filter; neither should infer skip from the other's rule evaluation, since GitLab
evaluates `rules:` per job).

---

## 6. ST-8 / OD-G — GPU serving

### 6.1 The budget, stated precisely

- Two physical RTX 2000 Ada cards, time-sliced ×3 each (confirmed live, not
  aspirational: `gpu-time-slicing.yaml`, `sharing.timeSlicing.resources[0].replicas:
  3`; runbook confirms via `kubectl get node … nvidia.com/gpu.sharing-strategy` =
  `time-slicing`) → **6** allocatable `nvidia.com/gpu` units.
- Allocation, verified by direct read of each manifest: `hope-lmstudio` requests
  `nvidia.com/gpu: "4"` at `replicas: 1` (`base/lmstudio.yaml:269,273`); `hope-stt`
  requests `"1"` (`base/stt.yaml:340,344`); `hope-stt-worker` requests `"1"`
  (`base/stt-worker.yaml:336,340`). **4 + 1 + 1 = 6/6 — fully allocated, zero spare.**
- This is WHY `overlays/dev/kustomization.yaml` patches `hope-stt`'s rollout strategy
  to `maxSurge: 0, maxUnavailable: 1` (confirmed at the patch block ~lines 328-341,
  `target: hope-stt`) even though BASE declares `maxSurge: 1, maxUnavailable: 0`
  (`base/stt.yaml:15-16`) — a surge pod would need a 7th GPU unit that does not exist.
  With `maxUnavailable: 1` and a single replica, every rollout is: kill the running
  pod, THEN schedule and warm the replacement — the exact "~30–50 s hard cut of live
  transcription several times a day" M-25 names, and (per §1.1 above) the SAME window
  in which the capacity-guard reconciler can strand a leaked slot if the replacement's
  first session lands mid-cold-load.

### 6.2 MPS for the STT slices

**Argument for**: NVIDIA's own device-plugin documentation states time-slicing gives
NO memory or fault isolation between clients sharing a slice — one pod's CUDA OOM or a
misbehaving kernel can affect every other pod time-sliced onto the same physical card,
which on this cluster today includes STT's realtime pod, STT's worker pod, and
whichever LM Studio replica lands on the same card via the anti-affinity-less
scheduler (`base/lmstudio.yaml` requests 4 of 6 units across 2 physical cards with no
guarantee of an even split — the same file's own comment at `lmstudio.yaml:257-258`
notes "a request of 2 is NOT guaranteed to span both cards"). MPS (Multi-Process
Service) gives per-client SM/queue limits and somewhat better fault containment than
plain time-slicing, at the cost of requiring the device plugin's MPS mode (mutually
exclusive with the current `timeSlicing` config at the CLUSTER level —
`gpu-time-slicing.yaml` would need to become an MPS `ClusterPolicy` patch, not an
additive change) and a driver/daemon (`nvidia-cuda-mps-control`) per node. MIG is
confirmed unavailable — Ada consumer/workstation parts (RTX 2000 Ada) are not on
NVIDIA's MIG-supported GPU list, so MPS is the ONLY available step up from plain
time-slicing on this hardware, not one of several options.

**Argument against / risk**: switching the cluster-wide `gpu-operator` sharing
strategy from time-slicing to MPS is a NODE-WIDE change (this cluster has exactly one
GPU node, `dell`/VM 200) that affects LM Studio and vLLM simultaneously with STT — it
is not something D6 can scope to "just the STT slices" at the k8s level, because
`gpu-time-slicing.yaml` configures the `ClusterPolicy`'s default sharing strategy for
the WHOLE `gpu-operator` namespace, not per-workload. A single mis-set MPS
`CUDA_MPS_ACTIVE_THREAD_PERCENTAGE` / pinned-memory limit under-provisioned for
whisper.cpp's actual working set would turn "no isolation" into "artificially throttled
below what time-slicing gave for free" — this needs a MEASURED trial (F9-G1's own
citation), not a blind cutover. Recommend a bounded experiment on a maintenance window
(convert the node to MPS mode, re-run the BP-6 concurrency curve, compare against the
time-sliced baseline) BEFORE any recommendation to adopt — this dossier does not have
that measurement and should not recommend a cutover without it. This is exactly
OD-G's own framing ("MPS after a measured trial") and this dossier concurs.

### 6.3 Releasing one LM Studio slice (OD-G, primary recommendation)

**Argument for**: this is the cheapest, lowest-risk fix for the rollout-downtime half
of M-25/ST-8. `hope-lmstudio` → `nvidia.com/gpu: "3"` frees exactly the 1 unit
`maxSurge: 1` needs to schedule a surge STT pod, restoring BASE's own declared
`maxUnavailable: 0` rollout behavior (zero-downtime STT deploys) without touching the
GPU sharing model at all — it is a resource-request edit in the deployment repo
(`base/lmstudio.yaml`), fully reversible, and orthogonal to the MPS question. The
runbook itself already frames time-slicing's whole purpose as "what makes a surge-first
rollout of an STT/vLLM/LM Studio pod possible at all" (`deployment-runbook.md:257-259`)
— today that purpose is UNREALIZED for STT specifically because the budget is fully
consumed.

**Risk**: LM Studio's 4-unit claim is presumably sized against its own concurrent
generation-throughput needs (the parent review does not establish why 4 was chosen,
only that it is the single largest claim in the fleet). Dropping to 3 could degrade LM
Studio's serving capacity under its own peak load. This needs a check with whoever
owns LM Studio's sizing (not this dossier's area) before landing, and should be
tried on the same maintenance window as any MPS trial (§6.2) so both GPU-budget
changes are validated together rather than serially re-disrupting the shared card.
**Recommendation stands** (yes for the slice) but the risk is real and specific to LM
Studio's own workload, not a hand-wave.

### 6.4 Node-local model copy from MinIO, FUSE as cold source

**Argument for**: F9-G2 (Cold-Start Model Delivery in Kubernetes Inference Serving,
2026) measures node-cached delivery at 11.7 s vs 40.7 min over object storage for
large-model cold starts — an order of magnitude. The s3fs FUSE mount
(`base/stt.yaml:47-137`) is a NETWORK-BACKED read on every cache miss; the 4.6 s cold
reload measured locally (§1.1) is on Apple Silicon/MPS reading from a LOCAL disk cache,
not the cluster's s3fs path — the cluster number is unmeasured and, per F9-G2's curve,
plausibly worse. A node-local read-through cache (e.g. an `emptyDir` or a small
node-local PVC that s3fs reads populate once and subsequent pods on the SAME node
reuse) would keep the s3fs mount as the COLD source (first read ever, or after a node
reschedule) while making the WARM path (repeat reads of the same slug, which is exactly
what TTL eviction + warm-on-boot produce) a local-disk hit instead of a network FUSE
read.

**Risk**: this cluster has exactly ONE GPU node (`dell`), so "node-local" here is
equivalent to "pod-local persistent," which re-introduces the EXACT hostPath-cache
shape TASK-855 deliberately RETIRED (`00-project-context.md`/`09-infrastructure-
devops.md` — TASK-855's whole point was "no weight ever lands on node disk"). A
node-local cache is a genuine reversal of a documented architectural decision, not a
tuning change, and needs an owner decision of its own (not something this dossier can
wave through under ST-8) — OD-G as written does not ask for this specifically, and I
would separate it out: recommend this ONLY if OD-F's warm-on-boot (§1.3) plus the TTL
write (§1.2(a)) are judged insufficient after being measured, since both of those
already remove the network-read cost from the common case (a model that's already
resident, kept resident by the 3600 s TTL and re-warmed at boot, never re-reads
through s3fs at all except on pod restart/roll — which QW-6's rollout-hygiene fix
(§5) makes rarer). On a single-node cluster the marginal benefit of a node-local cache
ON TOP of a long TTL + warm-on-boot is the pod-restart case only, which is exactly the
case §1.3's warm-on-boot task already re-populates from s3fs once at boot. Net
recommendation: **do not pursue this now**; re-evaluate only if TTL+warm-on-boot,
measured, still show an unacceptable pod-restart cold-start cost.

---

## 7. The liveness gap TASK-990 hands us — a wedged transcription loop

### 7.1 What exists today, and why it is insufficient

- `apps/stt/src/stt/health/api/routes.py:104-107` — `/health/live` returns a static
  `{"status": "healthy"}` with NO checks at all: "Kubernetes liveness probe — always
  returns 200 if the process is running." Per the coordination note, TASK-990
  repoints k8s's `livenessProbe` to THIS route and deliberately keeps it static — i.e.
  the design intent (correctly) is that liveness answers "is the event loop alive,"
  not "is every session healthy." A wedged DECODE loop for one session (audio still
  arriving on the WS/Redis-stream ingest path, but the shared per-model
  `threading.Lock` decode call never returns — e.g. hung on a native whisper.cpp call,
  a corrupted CUDA context, or a deadlock on the lock itself) leaves the FastAPI event
  loop perfectly responsive (health endpoints keep answering) while that session's
  transcription has silently stopped.
- No existing per-session bookkeeping tracks "last successful decode" —
  `session.py`/`session_manager.py` track `_last_snapshot_at`, `_last_audio_trim_at`,
  `_last_persisted_at` (confirmed by grep), but nothing named `last_decode_at` /
  `last_transcript_at`. M-46 (front-end, not this area) already names the CLIENT-side
  half of this gap ("no consumer detects a stalled session… the only watchdog is for a
  silent mic"); this section is the SERVER-side signal that a client-side "stalled"
  banner would need to consume, and it does not exist yet either.

### 7.2 Design principle: this is an observability/self-heal signal, NOT a liveness-probe wire-up

A pod serving N concurrent sessions (admission cap today: 20, per §2) must never have
its ENTIRE process restarted because ONE of those N sessions wedged — that would
convert a single-session decode hang into an outage for every other concurrently
active PHI consultation on the pod, which is a strictly worse blast radius than the
original bug. So the design is layered, matching the "primary mechanism is observable/
alertable, escalate to a restart only on a PROCESS-WIDE signal" posture already used
elsewhere in this platform (e.g. the BP-5/M-21 alert-rule design for RTF/queue-drops,
which page a human rather than auto-restart):

1. **Per-session watchdog (the actual detection).** Track two monotonic timestamps per
   session, updated where the data already flows:
   - `last_audio_at`: stamped in `_on_frame` (`session_manager.py`'s ingestion path,
     the same method that already appends to `audio_buffer` — `:3293-3349` per the
     parent review's citation) every time a frame is accepted.
   - `last_decode_at`: stamped when a partial OR final decode call RETURNS (success or
     controlled failure — anywhere the adapter's `__call__` returns control, whether it
     produced text or not; the point is "the lock was released and this session got a
     turn," not "the turn produced good text"). The natural site is the return path of
     `StreamingInferenceWorker.process_partial`/whatever processes a final, immediately
     after the `asyncio.to_thread` call that wraps `_decode_spans_locked` returns.
   - Computed condition, evaluated in the EXISTING `_heartbeat_loop` (already runs
     every `_heartbeat_interval_s` and already iterates live sessions for
     `_reconcile_capacity_guard`, `session_manager.py:4910-4947` — this new check is a
     sibling pass in the same loop, not a new timer): a session is **stalled** when
     `now - last_audio_at < audio_freshness_window` (audio is GENUINELY still
     arriving — this is what rules out a legitimately quiet consultation, see §7.3)
     **AND** `now - last_decode_at > stall_threshold` (no decode has completed in far
     longer than the served cadence would predict — threshold should be a multiple of
     `maxDecodeWindowSec`, e.g. 3-4x the served 7 s, since even a maximally backed-up
     session queued behind every other session's decodes should clear within a few
     multiples of one decode's worst-case duration, not tens of them).
   - `audio_freshness_window` should be seconds, wide enough to not fire on normal
     inter-utterance silence gaps (the served `maxUtteranceSec` is 60 s, and normal
     clinical pauses — thinking, examining a patient — can exceed that) — recommend
     keying it to whether `_on_frame` has been called AT ALL recently (audio frames
     arrive continuously from an open WS regardless of whether the patient is
     speaking, per the browser's 80 ms-frame uplink cadence — `stt-capture.worklet.ts`
     coalesces at 80 ms and sends continuously while the mic is live, silence and
     speech alike, since `useArcaAudio` does not gate frame SENDING on VAD/energy —
     only the STT-side preprocessor does). So `last_audio_at` staying fresh is a
     reliable "the WS connection and mic are alive" signal independent of whether the
     PATIENT is currently talking — exactly the distinction needed.

2. **Metrics + log, not auto-action, as the default.** Emit
   `stt_streaming_stalled_sessions_total` (counter) and a structured WARN log
   (`stt.streaming.session_stalled`, session_id, `audio_age_s`, `decode_age_s`) on
   first detection per session (edge-triggered, not re-logged every heartbeat tick
   while still stalled — use a per-session "already reported" flag cleared on
   recovery or session end). This alone closes the observability half of the gap:
   BP-5's dashboard/alert work (§8, out of D6's area but consuming this signal) can
   alert a human on `stt_streaming_stalled_sessions_total` rate, which is a FAR safer
   default than automated action given how new and unmeasured this signal is.

3. **Bounded per-session self-heal (optional, second phase).** Once the signal has
   been observed in production and its false-positive rate is known (see §8's test
   plan), a stalled session past a LONGER bound (e.g. 2x the WARN threshold) could be
   force-finalized with an explicit `interrupted`/`stalled` reason — giving the
   clinician a deterministic "transcription lost, please restart" state instead of
   open-ended silence — rather than left to the client's own eventual reconnect/
   timeout behavior. This is a PER-SESSION action (finalize one session), never a pod
   restart, and should ship only after phase 2's metric has been watched for at least
   one clinic week.

4. **Process-wide escalation (the only path that should ever touch liveness).** If
   MULTIPLE sessions are simultaneously stalled at the same instant — a threshold like
   "≥ 2 stalled sessions, or ≥ 25% of active sessions, whichever is smaller in absolute
   terms" — that pattern is no longer explainable as one session's bad luck; it is
   evidence of a PROCESS-WIDE wedge (the shared per-model lock itself deadlocked, a
   corrupted CUDA context poisoning every session bound to that model, a GIL-holding
   native call that never returns). ONLY at this aggregate threshold does a pod
   restart become the correct remedy (every session is already degraded; restarting
   trades a wedged pod for a `preStop`-drained, TASK-990-owned rollout of a fresh
   one). Do not wire this into `/health/live` directly as a first cut (that file
   belongs to TASK-990 and per the brief is deliberately kept static) — surface it as
   a SEPARATE alert rule first (`stt_streaming_stalled_sessions_total` aggregated
   across the pod crossing the threshold, alerting a human), and treat "should this
   also fail `/health/live`" as an explicit follow-up owner decision once the
   aggregate signal has been observed to actually correlate with real wedges and not
   with, say, a GPU-memory-pressure slowdown that recovers on its own. Auto-restart on
   an unproven signal risks exactly the false-restart failure mode the brief asks this
   design to avoid.

### 7.3 Avoiding false positives during a legitimately quiet consultation

Restated precisely because it is the crux of the design: the gate is `audio still
arriving` AND `no decode completing`, never `no decode completing` alone. A silent
exam room, a long pause while a clinician reviews a chart, or a patient who has left
the room all produce `last_audio_at` staying FRESH (frames keep arriving — the mic
capture and 80 ms WS uplink do not pause for silence) while `last_decode_at` ALSO stays
fresh, because the STT-side energy/VAD-gated segmentation (`preprocessor.py`, per the
parent review) simply never opens an utterance during genuine silence — there is
nothing to decode, so there is no missing decode to flag. A stall is specifically
"speech-shaped audio kept arriving, the segmenter presumably opened or should have
opened an utterance, and no decode call for THIS session has returned in an
implausibly long time" — the `last_audio_at` freshness check is what lets the detector
tell "nothing to decode" (healthy, quiet) apart from "something should have decoded and
didn't" (wedged). This is also why the audio-continues-during-silence property of the
capture pipeline (deliberate, per the browser design — frames are not gated on
speech/VAD client-side, only server-side segmentation decides what to decode) is load-
bearing for this design and should not be "fixed" by a future change that stops
sending frames during silence, or this detector's false-positive-avoidance breaks.

---

## 8. Test plan

### 8.1 What CI can prove (no cluster, no live model)

- **Unit, `test-stt`** (already the right tier per `.rules-stt`): kwargs/behavior
  tests requiring no GPU —
  - `_reconcile_capacity_guard` behavior under a session mid-creation (mock
    `self._sessions` not yet containing an id while `self._capacity_guard` already
    holds its slot; assert the reconciler does NOT release it within some grace
    window — this is the §9.1 defect's regression test once fixed).
  - The `stalled_sessions` detector's pure logic (§7.2/7.3): feed synthetic
    `last_audio_at`/`last_decode_at` timestamp pairs, assert the stalled/not-stalled
    boundary matches the documented condition, including the "audio fresh, no decode
    due yet" (healthy-quiet) case and the "audio fresh, decode overdue" (stalled)
    case — pure function, no I/O, no GPU.
  - `_get_model_lock`/priority-gate unit tests (§2.3): assert a final queued behind
    in-flight partials for the SAME model is granted the lock before a partial queued
    after it, using `threading` primitives and no real decode.
  - CUDA-backend-assertion unit test (§3.3): mock the loader's captured log lines
    both with and without a CUDA-init marker, assert `ModelLoadError` fires only when
    the config declared a GPU device and no marker was found.
  - `stt.modelCache.ttlSeconds`/`memorySizeMb` plumbing: assert `apply_retention`
    still clamps a written 3600 correctly (already covered by
    `clamp_cache_ttl_seconds`'s existing unit tests per the module docstring — extend
    only if the SYSTEM-tier write path itself needs new coverage, which is an
    applications-layer test, not stt's).
  - `hf_home_manifest_divergence` test fix (§4.3): update the pinned string, add an
    assertion the retired hostPath string is ABSENT.
- **What CI CANNOT prove**: anything requiring an actual GPU, an actual CUDA arch
  mismatch, real concurrency contention under a real per-model lock held by REAL
  decode latency, or real s3fs/warm-on-boot timing. All of the below need the cluster.

### 8.2 Live measurements for the orchestrator

| # | Arms | Metric | Decision it settles |
|---|---|---|---|
| LM-1 | `stt.modelCache.ttlSeconds` at 600 (current) vs 3600 (proposed), same served agent, N≥5 sessions spaced >600s apart on a quiet stack | `session_create_ms` p50/p95 split cold-vs-warm; count of `reason=ttl` evictions per hour of idle-spaced traffic | Confirms 1.2(a)'s TTL write removes the recurring cold start before OD-F is even built; go/no-go for shipping the DB write immediately |
| LM-2 | Cold session-create with `stt.warmDefaultAsrOnBoot` OFF (today) vs ON, immediately after a fresh pod roll, N≥5 rolls | `session_create_ms` for the FIRST session after roll; time from pod `Ready` to warm-task completion; whether `/health/ready`'s existing checks (unaffected by the warm task, per §1.3 step 3) still report healthy throughout the warm | Settles OD-F: does warm-on-boot actually remove the post-roll cold penalty, and does it ever delay/fail readiness (it should not, by design — this proves the design holds) |
| LM-3 | `_reconcile_capacity_guard` behavior during a cold load: force a cold reload (evict then create) while watching `active_session_ids` vs `self._sessions` membership across at least 2 heartbeat ticks, N≥5 | Whether the in-creation session's capacity slot gets released mid-load (the §9.1 defect); count of "Reconciled leaked capacity slots" WARN logs during a cold load | Confirms/refutes the observed-but-untriaged defect from the local run as a REPRODUCIBLE cluster issue, and validates whatever fix ships for it (grace window / register-before-admit) |
| BP-6 (from the parent ticket, this dossier's §2.4 depends on it) | WS harness at N = 1, 2, 3, 4, 6 concurrent sessions, same served agent/geometry, on CUDA | `commit_latency_ms` p50 per N (relative to N=1); `inference_latency` p95 per N; `stt_streaming_lock_wait_seconds` p50/p95/p99 per N, split `{partial, final}` | Sets `stt.streaming.maxConcurrent` to the largest N within 1.4x of N=1 commit p50 with inference p95 < 1s (§2.4's exact rule); tells whether the finals-before-partials priority gate (§2.3) is worth building at all (if lock-wait for finals is negligible at every measured N, skip it) |
| LM-4 | CUDA-arch assertion (§3.3) exercised on a DELIBERATELY wrong-arch build (e.g. force `CMAKE_CUDA_ARCHITECTURES=75` — Turing, guaranteed absent on Ada) loaded on the real cluster GPU | Does the assertion fire at load time with the named error, or does the pod silently serve CPU-decoded/aborted results | Proves the assertion actually catches the failure mode it's designed for, BEFORE trusting it as the safety net for the multi-arch build (§3.3) |
| LM-5 | Stalled-session detector (§7) run against a DELIBERATELY induced hang (e.g. a debug build that sleeps inside the lock for one session) alongside N-1 healthy concurrent sessions, vs a genuine room-tone/silent-consultation fixture (BP-7's clip, reused) | Whether the induced hang is flagged within the designed threshold; whether the silent fixture produces ZERO stalled-session events over its full duration | Validates the detector fires on a real wedge and does NOT false-positive on genuine silence — the two failure modes the design must distinguish (§7.3) |
| LM-6 | Rollout timing before/after QW-6's `changes:` scoping (§5) — count STT-touching commits vs actual `build-stt` runs over a measured week each side of the change | STT rollouts/week vs STT-touching commits/week (ratio should approach 1:1 after the fix, vs today's ~1:1-with-every-unrelated-commit) | Confirms the CI scoping fix actually reduces rollout frequency in practice, not just in rule logic |

Every live measurement above should carry the BP-1 fingerprint (agent version, model
slug+digest, geometry, device, engine build) per the parent review's Environment
Control section, so a result is attributable to the arm under test and not to an
unrelated concurrent config drift.

---

## 9. New defects

| Claim | Evidence | Severity | Suggested fix |
|---|---|---|---|
| The capacity-guard reconciler can release an in-creation session's slot mid-cold-load: `_reconcile_capacity_guard` (heartbeat-driven, every `_heartbeat_interval_s`) treats any id present in `_capacity_guard.active_session_ids` but ABSENT from `self._sessions` as "leaked" and releases it. A session admitted into the capacity guard but still inside a cold model load (session not yet registered in `self._sessions`) is indistinguishable from a genuinely leaked slot if a heartbeat tick lands during that window — and the cluster runbook already documents exactly this outcome as a KNOWN, reproduced issue ("The session is then reconciled as a leaked slot") for the 16.4 s cold-load case | `apps/stt/src/stt/streaming/session_manager.py:4910-4947` (`_reconcile_capacity_guard`, `_heartbeat_loop`); `hope-v2-deployment/docs/deployment-runbook.md:842-849`; local run note in the parent review §2.3 ("the capacity reconciler released the in-creation session's slot during the cold load") | high — directly compounds M-17's cold-start problem: a slow cold load can be double-penalized (the session already pays the cold-load latency, and can ALSO lose its capacity slot mid-load, producing the 503 the runbook documents) | Register the session's id into a "pending/creating" set (or into `self._sessions` itself, in a not-yet-ready state) BEFORE capacity admission completes, so the reconciler never sees a gap; or add a grace window to `_reconcile_capacity_guard` (skip ids admitted within the last `_heartbeat_interval_s * 2`) so a session that is merely mid-creation is never mistaken for a leak. LM-3 (§8.2) is the reproduction test |
| `packages/applications/.../descriptors/service-runtime.descriptors.ts` documents the Python service's own bootstrap default for `stt.modelCache.ttlSeconds` as `3600` in its header comment ("verified 2026-07-20") but registers a SERVED default of `600` for the same key two sections later, with no comment explaining the divergence — a reader trusting the header comment (which is the file's own stated source-of-truth methodology) would believe the served default matches the Python field's `3600`, when the actual served value (no SYSTEM row exists) is `600` | `service-runtime.descriptors.ts:15` (header comment) vs `service-runtime.descriptors.ts:41` (`SERVICE_RUNTIME_DEFAULTS['stt.modelCache.ttlSeconds'] = 600`); `apps/stt/src/stt/core/config/settings.py:270-278` (Python field default `3600`) | medium — not a runtime bug (600 is a valid, in-clamp value, and it IS what's served today, consistently with the parent review's own M-17 finding), but it is a documentation-vs-code contradiction inside the SAME file, in the file whose whole stated purpose is "changes ZERO runtime behaviour: every default below is transcribed verbatim from the consuming Python service's own fallback" — that promise is broken for this one key today | Either update the header comment to state the served/registered value is deliberately lower than the Python bootstrap fallback (and why), or reconcile them once QW-4's SYSTEM-tier write (§1.2(a), recommended value 3600) lands — at which point the served value and the header comment agree again and the drift resolves itself. Flag for whoever lands the QW-4 write to also touch this comment |
| `hf_runtime_models` cache size estimator (`_estimate_for`) can be called with a key that yields `None` from `self._memory_estimates.get(key)` and raises inside `int(None)`, caught by the surrounding `try/except` and logged as `%s.estimate_failed` — observed once during the local cold-load run ("TypeError in the cache size estimator") but not yet triaged to a specific call site or reproduced deliberately | `packages/py-runtime-models/src/hope_runtime_models/cache.py:423-431` (`_estimate_for`'s try/except swallowing the TypeError); local run note in the parent review §2.3 | low — the exception is already caught and degrades to a `0` estimate rather than crashing, so this is a silent-degradation bug (pre-load pressure relief under-estimates a model's footprint) not a stability bug, but it is untriaged and its trigger condition is unknown | Reproduce deliberately (a load for a slug never previously `setdefault`'d into `_memory_estimates`, e.g. a fallback-chain model that skips the normal `get_or_load` entry path) and either fix the caller to always `setdefault` before any `_estimate_for` call can reach it, or make `_estimate_for` treat `None` as `0` explicitly instead of relying on the exception path (clearer intent, same behavior) |
| `whisper-large-en-medical-260726-merged-gguf-q8_0`'s `memorySizeMb` (1700) is identical to its f16 sibling `whisper-large-en-medical-260726-merged-gguf` (also 1700), where the sibling ml-en pair shows the expected ~53% quantization ratio (`arcaai-whisper-large-ml-en-gguf` f16 1700 vs `arcaai-whisper-large-ml-en-gguf-q8_0` 900) — looks like a copy-paste from the f16 row rather than a measured q8_0 footprint, and it over-reserves pre-load budget for exactly the row an operator would pick to save memory | `packages/database/src/prisma/db_main/seed/ai-models/audio.ts:256` (f16, 1700) vs `:295` (q8_0, 1700); pattern comparison against `:123` (ml-en f16, 1700) and `:167` (ml-en q8_0, 900); confirmed present in the live dev DB `core."AiModel"` as well, so it is not a stale-seed-only issue | low — no functional break (a too-high estimate only over-reserves pressure-relief budget, it does not block a load), but it is a data-quality defect on a row that exists specifically to be the memory-saving choice | Re-derive from the actual q8_0 GGUF file size (expect ~850–900 MB by the ml-en pair's ratio) and correct the seed row; out of scope for this dossier to edit — flag for the contract/data-seed lane that owns `audio.ts` |

---

*Dossier complete. No tracked files were edited in either repo; all recommendations
above are designs for follow-up tickets. Every file:line citation was re-read directly
from the current worktree (`agent-transcription-coordination-9dbc25`, based on
`dev-2.2 @ 3f9145a98`) or the current `hope-v2-deployment` checkout at the time of
writing, not copied verbatim from the parent review without verification — four
places (§4.3's Dockerfile/test/runbook triad, §1.2(a)'s registry-default contradiction,
§1.2(b)'s `memorySizeMb` state, and §9's capacity-reconciler mechanism) were
independently confirmed against source rather than taken on the parent review's word
alone. One of those four — `memorySizeMb` — was checked against the WRONG file on the
first pass (the generic seed loader rather than the per-model data file it reads from)
and produced an incorrect claim ("unset on every row"); corrected 2026-09-19 after the
coordinator verified the actual seed data and the live dev DB. The correction also
surfaced a real, narrower defect in the same data (the medical q8_0 row's copy-pasted
memory estimate, §9), which the original wrong claim would never have found.*
