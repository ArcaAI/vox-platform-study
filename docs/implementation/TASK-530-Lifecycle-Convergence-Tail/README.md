# TASK-530 — Model-Lifecycle Convergence Tail (harness D-08, stt-v2 adoption, TASK-529 errata)

- **Status**: Pending
- **Type**: feature / refactor
- **Program**: Phase 3 tail of the [2026-07-20 agentic platform program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §4 · frozen design **AD-4** · closes the residue of [TASK-529](../TASK-529-Model-Lifecycle-Retention/README.md)
- **Numbering**: TASK-530 is **reserved by the program plan for exactly this** — plan §325: *"TASK-530 — reserved. Intentionally unallocated… If TASK-529 proves too large in execution, split its concurrency work out under this number."* Verified 2026-07-20: no `TASK-530` directory exists in `docs/implementation/`. Numbering confirmed, not invented.
- **Size**: M · **Lanes**: D (stt-v2) + E (harness) + docs
- **Dependencies**: TASK-529 (**must be merged first** — this ticket consumes `packages/py-runtime-models` and the `<svc>.modelCache.*` settings keys it landed). No dependency on TASK-528.
- **Owner decisions carried in**: **OD-3** (shared uv package `packages/py-runtime-models`, import name `hope_runtime_models`) · **OD-5** (default retention TTL 600 s, clamped 60–3600 s)

---

## 1. Requirement Analysis

TASK-529 delivered 8 of its 10 plan steps. Two were not implemented, and its README carried three factually stale claims that were discovered only at execution time. This ticket closes all of it, so that owner expectation **E6** — *"All models load on request, retained max 1 h / min 1 min (global-admin-controlled retention), evicted sooner under VRAM pressure"* — is closed with **no service exempt**.

| Req | Meaning | IDs closed |
|---|---|---|
| R1 | Harness MiniCheck entailer becomes bounded and evictable — resolve the sync/async fork the AD-4 contract did not anticipate | **D-08** (the last open defect of the L-series) |
| R2 | stt-v2's cache composes the shared contract — the code-sharing half of GAP-L1, which is all that remains there | GAP-L1 (completion) |
| R3 | TASK-529's README §2/§3.2 corrected against what the tree actually contains; **DR-1** (the `<svc>.modelCache.*` key grammar) ratified as the frozen contract, superseding §3.2's `models.retention.*` | plan-conformance / §2.5 doctrine |
| R4 | The two shared-cache `unload`-hook defects TDD caught in TASK-529 get permanent regression guards at the contract level, not just at their fix sites | GAP-L3 (durability) |
| R5 | tts-v2 IndicParler/IndicF5 join Kokoro under TTL-unload (TASK-529 landed lazy-load for all three but TTL-unload for Kokoro only) | **D-09** (completion) |

**Explicitly out of scope**: vLLM sleep mode (documented future opt-in, unchanged); the `AiRuntimeProfile` schema and settings write-lane (TASK-524); concurrency knobs beyond what TASK-529 already reads; anything in TASK-528's surface.

---

## 2. Current State Evaluation (code-verified 2026-07-20, against the TASK-529 worktree)

### 2.1 R1 — the harness sync/async fork (the actual blocker)

Verified by reading both sides:

- **The consumer is synchronous.** `apps/harness/src/harness/temporal/activities.py:375` — `def _atomic_fact_entailer(settings, model_path=None) -> NliEntailer` is a plain `def`, and it calls `load_minicheck_entailer(...)` directly at `:390` inside a `try/except` that falls back to `DeterministicOverlapEntailer`. It is the **sole** call site; workflow code never touches it.
- **The contract is async-only.** `packages/py-runtime-models/src/hope_runtime_models/cache.py` — `ModelCache.get()` is `async`, single-flight is built on `asyncio.Lock` + in-flight `Future` with `asyncio.shield`.
- **What exists today** (unchanged by TASK-529): `minicheck_entailer.py:164-166` is still a module dict `_ENTAILER_CACHE: dict[str, LlamaCppMiniCheckEntailer]` with the comment *"loaded once per worker, keyed by model path"* — cached forever, no eviction, no unload. That is D-08 verbatim.

So the fork is real and not a matter of taste: you cannot `await` from `_atomic_fact_entailer` without changing its signature, and changing its signature propagates into the activity call chain.

**Decision (frozen for this ticket): add `SyncModelCache` to the shared package.** Rationale, stated rather than buried:

- The consumer is genuinely synchronous — `llama_cpp.Llama` construction is a blocking CPU/GPU call, not I/O awaiting a socket. Wrapping a blocking load in an async cache buys nothing.
- An async conversion would push `async` up through `_atomic_fact_entailer` into the activity body. Activities are the right place for I/O, so it is *legal* — but it is a wider blast radius on the clinical path for zero behavioral gain, and Karpathy §2/§3 say don't.
- `SyncModelCache` is a small sibling (`threading.Lock` + `threading.Event` for single-flight instead of `asyncio`), sharing the same policy engine, the same `EVICTION_REASONS`, the same `clamp_cache_ttl_seconds`, the same `CacheStats`/`MetricsSink`. **Policy is shared; only the concurrency primitive differs.** That is the whole point of "contract, not framework".

Rejected alternative recorded for the reviewer: `asyncio.run_coroutine_threadsafe` against the activity loop — deadlock-prone from inside a running loop, and strictly worse than a lock.

### 2.2 R2 — stt-v2 is *already* admin-controlled; only code-sharing is left

TASK-529's DR-2 found §2.1's matrix stale. Re-verified: stt-v2's `models/cache.py` (567 lines) already reads retention from the control plane and already double-enforces the `[60, 3600]` clamp. **D-11 was already fully closed** — the dead `GlobalSettingRead` model *and* its seed rows were gone before TASK-529 started.

So R2 is a pure refactor with no behavior delta: compose `hope_runtime_models.ModelCache`, keeping the format→loader map and `LoadedModel` MB estimates as injected `factory`/`unload`/estimate hooks. It was deferred in TASK-529 as a deliberate risk call (567 lines on the ASR hot path, late in a large ticket) — correct call then, and it is the right size for a ticket of its own now.

**Hard parity gate**: `apps/stt-v2/tests/unit/test_model_cache.py` and `test_model_cache_ttl.py` must pass **unmodified**. If either needs editing, the refactor changed behavior and must be reworked, not the test.

### 2.3 R3 — the three stale claims, and why DR-1 is right

| TASK-529 README claim | Reality in the tree | Action here |
|---|---|---|
| §2.1: stt-v2 "Admin-controlled ❌" | Already wired to the control plane | Correct §2.1 |
| §2.3/§4.3: D-11 dead `GlobalSettingRead` + seed rows need deleting | Already deleted before the ticket opened | Mark D-11 closed-on-arrival |
| §3.2: retention keys are `models.retention.*` | TASK-525 shipped and froze `<svc>.modelCache.*`; `resolveForService` carries an explicit comment reserving the guardrail/harness/tts-v2 subsets *for TASK-529 to fill* | **Ratify `<svc>.modelCache.*`**; §3.2's grammar is superseded |

**DR-1 ratification.** TASK-529's agent used the landed grammar rather than creating a second key family for one knob. That is correct and is hereby the frozen contract: §2.5's Completion & Cleanup Doctrine explicitly forbids redundant parallel implementations, and a `models.retention.ttlSeconds` alongside a `<svc>.modelCache.ttlSeconds` would be exactly that. This ticket records the ratification in TASK-529's README so the deviation is a **recorded decision row**, not silent drift.

### 2.4 R4 — the two defects TDD caught, and why they need contract-level guards

During TASK-529 the conformance suite caught two real defects **in the shared cache itself**: LRU-overflow eviction and lazy-TTL eviction both dropped entries **without calling the `unload` hook**. Consequence had they shipped: every evicted model's weights stay resident — the cache reports the eviction, frees nothing, and the VRAM/MB budget silently stops meaning anything. That is the precise failure E6 exists to prevent.

They were fixed with dedicated tests. What is missing is a guard that generalizes: **every** eviction path must call `unload` exactly once. R4 adds a path-parameterized conformance clause so a future eviction path (a new pressure source, a new reason label) cannot regress this by construction — `defense-in-depth`, not a spot fix.

### 2.5 R5 — tts-v2 completion

TASK-529 §4.7 made Kokoro/IndicParler/IndicF5 lazy and put **Kokoro** behind the shared cache with TTL-unload. IndicParler/IndicF5 are lazy but never TTL-unloaded, so D-09 is partially closed. Under §2.5 doctrine a partial implementation is finished end-to-end — this ticket brings the other two under the same cache instance.

---

## 3. Architecture & Patterns

### 3.1 `SyncModelCache` — the sibling, not a second framework

Added to `packages/py-runtime-models/src/hope_runtime_models/cache.py` (same module — they share the policy helpers):

```
SyncModelCache[T](factory, *, unload=None, max_size, ttl_seconds,
                  time_func=time.monotonic, metrics=…, vram_probe=None)
  .get(key) -> T              # single-flight per key via threading.Lock + Event; failure not cached
  .pin/.unpin/.pin_many/.unpin_many
  .evict(key) -> bool         # refuses pinned
  .sweep() -> int
  .clear() -> int
  .stats() -> CacheStats      # SAME dataclass as the async cache
  .configure(...)
```

Shared verbatim with the async cache (imported, not duplicated): `clamp_cache_ttl_seconds`, `EVICTION_REASONS`, `CacheStats`, `MetricsSink`, `ModelUnavailableError`, the ttl→lru→vram ordering, the all-pinned soft ceiling, and the "pins survive reload / last unpin restarts the idle clock" semantics.

**Sweep in a sync world**: harness has no asyncio loop guaranteed around the entailer, so `SyncModelCache` does **not** own a background task. It sweeps lazily on `get()` (as all three original caches did) **plus** exposes `sweep()` for the harness FastAPI app's existing async sweeper to call. An idle entailer is therefore released even when its key is never re-requested — the §2.2-of-TASK-529 sweeper gap stays closed for this cache too.

### 3.2 Harness adoption — activity-side only, replay-safe by construction

`minicheck_entailer.py`: `_ENTAILER_CACHE` module dict → one module-level `SyncModelCache` keyed by the **same** composite key (`f"{model_path}|{n_ctx}|{n_threads}|{n_gpu_layers}|{threshold}"`), with an `unload` hook that drops the `Llama` handle. `load_minicheck_entailer` keeps its exact signature and return type, so `_atomic_fact_entailer` is **unchanged** — including its `try/except` fallback to `DeterministicOverlapEntailer`, which must keep working when a *reload* fails, not just a first load.

Because the sole call site is activity-side (`activities.py:390`) and no workflow code changes, replay compatibility is preserved by construction. `tests/unit/temporal/test_replay_compat.py` stays **untouched** and is a hard gate.

Calibration: `verify_calibration()` currently runs once per load. After eviction+reload it must run **again** — a reloaded entailer that skips calibration could silently mis-score the clinical path. Explicit test.

### 3.3 Retention keys (consuming the ratified grammar)

`harness.modelCache.ttlSeconds` / `.maxModels` (default 1, behavior-preserving) and the tts-v2 subset, filled through the same `resolveForService` path TASK-529 used — the comment reserving those subsets is the contract being honored, not extended.

---

## 4. Implementation Plan (ordered; parity before policy)

| Step | Work | Files |
|---|---|---|
| 4.1 | **`SyncModelCache`** — RED conformance suite first, parameterized over BOTH cache classes for every policy clause | UPDATE `packages/py-runtime-models/src/hope_runtime_models/cache.py`; UPDATE `packages/py-runtime-models/tests/test_cache_contract.py` |
| 4.2 | **R4 unload-hook guard** — path-parameterized clause: every eviction path (explicit `evict`, ttl-lazy, ttl-sweep, lru-overflow, vram-pressure, `clear`) calls `unload` exactly once, for both cache classes | UPDATE `packages/py-runtime-models/tests/test_cache_contract.py` |
| 4.3 | **Harness D-08** — replace `_ENTAILER_CACHE`; `unload` drops the `Llama` handle; wire `harness.modelCache.*`; re-calibrate on reload; register `sweep()` with the app's sweeper | UPDATE `apps/harness/src/harness/sensors/inferential/minicheck_entailer.py`, `core/config.py`, `core/metrics.py`; NEW `apps/harness/src/harness/tests/unit/sensors/test_minicheck_cache.py` |
| 4.4 | **stt-v2 convergence** — compose the shared cache; loader map + MB estimates become injected hooks. **Parity gate before anything else.** | UPDATE `apps/stt-v2/src/stt_v2/models/cache.py`; NEW `apps/stt-v2/tests/unit/test_model_cache_contract.py` |
| 4.5 | **tts-v2 completion (D-09)** — IndicParler + IndicF5 under the same cache instance as Kokoro, TTL-unload + gauge to 0 | UPDATE `apps/tts-v2/src/tts_v2/providers/{indic_parler,indic_f5}.py`; UPDATE `apps/tts-v2/src/tts_v2/tests/unit/test_lazy_lifecycle.py` |
| 4.6 | **TASK-529 errata + DR-1 ratification** — correct §2.1/§2.3/§3.2; add the ratification row to §10; flip its Status to Review once its DoD holds | UPDATE `docs/implementation/TASK-529-Model-Lifecycle-Retention/README.md` |
| 4.7 | **Docs tail** — runbook gains the harness + tts-v2 rows and the sync-vs-async cache note; comment deltas TASK-529 left pending (`minicheck_entailer.py:164-165`) | UPDATE `docs/operations/inference/model-retention.md`; UPDATE `apps/harness/README.md` |

**Ownership manifest (exclusive)**: `packages/py-runtime-models/**` · `apps/harness/src/harness/sensors/inferential/minicheck_entailer.py` + `core/{config,metrics}.py` + the new test · `apps/stt-v2/src/stt_v2/models/cache.py` + its tests · `apps/tts-v2/src/tts_v2/providers/{indic_parler,indic_f5}.py` + `tests/unit/test_lazy_lifecycle.py` · the two docs. **No file overlaps TASK-528.** All TASK-529 files are inherited, not concurrent — 529 must be merged first.

---

## 5. TDD Plan (RED first — paste real failing output into §9 before implementing)

### 5.1 Contract (`packages/py-runtime-models/tests/test_cache_contract.py`)

Every existing clause re-parameterized over `[ModelCache, SyncModelCache]`, plus:

1. `test_sync_single_flight_concurrent_gets_one_load` — N real threads, one factory call, all get the same object.
2. `test_sync_factory_failure_not_cached_and_propagates` — and the next `get` retries.
3. `test_unload_called_exactly_once_per_eviction_path[path]` — **R4**, parameterized over all six paths × both classes.
4. `test_sync_sweep_releases_idle_unpinned` — fake clock.
5. `test_sync_pinned_survives_ttl_and_lru_pressure`.
6. `test_stats_shape_identical_across_cache_classes` — guards the "one dashboard, two classes" claim.

### 5.2 Harness (`apps/harness/src/harness/tests/unit/sensors/test_minicheck_cache.py`, hermetic)

1. `test_entailer_evicted_after_ttl_and_reloaded` — fake clock; `Llama` stubbed.
2. `test_unload_releases_llama_handle` — the D-08 point: eviction actually frees.
3. `test_calibration_reverified_on_reload` — `verify_calibration` called again after evict→reload.
4. `test_calibration_failure_on_reload_falls_back_to_deterministic` — `_atomic_fact_entailer`'s existing safety net survives a *reload* failure.
5. `test_load_minicheck_entailer_signature_unchanged` — the seam that keeps the call site sync.
6. **`test_replay_compat.py` untouched and green** — hard gate.

### 5.3 stt-v2

- **Parity, first and unmodified**: `apps/stt-v2/tests/unit/test_model_cache.py` + `test_model_cache_ttl.py`.
- NEW `test_model_cache_contract.py` — the template instantiated against stt-v2's wiring; asserts the loader map still routes by format and `loader.unload()` still fires on evict.

### 5.4 tts-v2

`test_lazy_lifecycle.py` extended: for **each** of Kokoro / IndicParler / IndicF5 — first synth loads (gauge 0→1); idle past TTL unloads (gauge →1→0); `TTS_WARMUP_ENABLED=true` restores boot-warm; load failure → 503 with the provider still registered.

### 5.5 Gates

`pnpm py:harness:test|lint|typecheck` · `pnpm py:stt-v2:test|lint|typecheck` · `pnpm py:tts-v2:test|lint|typecheck` · `pytest packages/py-runtime-models/tests/` · `uv lock --check` clean.

> **Worktree hazard (verified 2026-07-20 — read before running any Python gate).** `arcaenv`'s editable installs are `.pth` files hardcoding the **main** checkout (e.g. `__editable__.stt_v2-2.0.0.pth` → `<main>/apps/stt-v2/src`). A bare `pnpm py:<svc>:test` inside a worktree collects the worktree's test *files* but imports **main-tree source** — a green run proves nothing. Export `PYTHONPATH=<worktree>/apps/<svc>/src` before every pytest gate, and state in §9 that you did.

House constraints: fake clocks only, no `sleep` (real threads in the sync single-flight test are the one exception, and they synchronize on `Event`, never on timing); NVML always stubbed; seed randomness **inside the test body** (pytest-randomly reseeds numpy per-test *after* fixtures); harness suite stays hermetic — no live Temporal, no network.

---

## 6. Acceptance & Definition of Done

- [ ] `SyncModelCache` passes every contract clause the async cache does; `CacheStats`/reason labels identical
- [ ] **D-08 closed**: `_ENTAILER_CACHE` gone; entailer evictable; `unload` frees the `Llama` handle; calibration re-verified on reload; fallback survives reload failure
- [ ] Replay fixtures untouched and green; harness suite still hermetic
- [ ] stt-v2 parity gate passed with its two pre-existing test files **unmodified**, then contract-conformant
- [ ] **D-09 fully closed**: all three tts-v2 local engines lazy + TTL-unloaded
- [ ] R4 guard: `unload` proven called exactly once on all six eviction paths × both cache classes
- [ ] TASK-529 README errata applied; **DR-1 ratified as a recorded decision row**; its Status flipped to Review
- [ ] All gates green with pasted real output, **each stating the `PYTHONPATH` pin used**
- [ ] Runbook + comment deltas complete

## 7. Risks & Rollback

| Risk | Mitigation / rollback |
|---|---|
| Two cache classes drift apart over time | Every policy clause is parameterized over both; `test_stats_shape_identical_across_cache_classes` pins the shared surface. Policy helpers are imported, not copied. |
| stt-v2 refactor regresses the ASR hot path | Parity gate on two unmodified pre-existing test files is a hard stop before any policy wiring. Rollback: revert one file — the shared package is additive. |
| MiniCheck reload cost on the clinical path (GGUF load is seconds) | `harness.modelCache.maxModels` default 1 preserves today's residency; only *idle* entailers evict. Raise `harness.modelCache.ttlSeconds` at runtime — no deploy. |
| A reloaded entailer is mis-calibrated and silently mis-scores | Calibration re-verified on every load incl. reload; failure falls back to the safe deterministic entailer, which never auto-PASSes. Two explicit tests. |
| Sync cache deadlock under nested `get` | Single-flight uses per-key `Event` waits, never a held lock across the factory call; a concurrency test with real threads is a gate. |
| Worktree PYTHONPATH hazard produces false-green gates | Called out in §5.5; §9 must state the pin per gate. |

## 8. References

- [TASK-529](../TASK-529-Model-Lifecycle-Retention/README.md) — parent; AD-4 contract, §3.3 engine matrix, DR-1…DR-6
- [TASK-528](../TASK-528-Model-Discovery-Hub/README.md) — concurrent, zero file overlap
- Program plan §325 (TASK-530 reservation), §2.5 Completion & Cleanup Doctrine, §8 OD-3/OD-5
- Findings §3-E6, D-08/D-09, GAP-L1/L3
- Rules: `.claude/rules/06-python-services.md` (uv workspace, test locations, Temporal determinism) · `09-infrastructure-devops.md`
- Repo memory: pytest-randomly numpy reseed; worktree `.pth` → main-checkout hazard; `uv lock` at root

## 9. Implementation Summary

_Pending_

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket authored from the TASK-529 execution outcome. Number confirmed against plan §325's explicit reservation. Scope: D-08 sync/async fork (resolved as `SyncModelCache` with rationale + rejected alternative recorded), stt-v2 convergence with a hard parity gate, D-09 completion, contract-level `unload`-hook guard for the two defects TDD caught in TASK-529, and TASK-529 README errata incl. **DR-1 ratification** of the `<svc>.modelCache.*` key grammar over the superseded §3.2 `models.retention.*`. Status Pending — awaiting owner approval per rule 01 Phase 3 gate. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end; redundant implementations are converged and deleted. This ticket exists to satisfy that doctrine for TASK-529's residue. |
