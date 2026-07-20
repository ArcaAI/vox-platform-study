# TASK-530 — Model-Lifecycle Convergence Tail (harness D-08, stt-v2 adoption, TASK-529 errata)

- **Status**: Review
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

- [x] `SyncModelCache` passes every contract clause the async cache does; `CacheStats`/reason labels identical
- [x] **D-08 closed**: `_ENTAILER_CACHE` gone; entailer evictable; `unload` frees the `Llama` handle; calibration re-verified on reload; fallback survives reload failure
- [x] Replay fixtures untouched and green; harness suite still hermetic
- [x] stt-v2 parity gate passed with its two pre-existing test files **unmodified**, then contract-conformant
- [x] **D-09 fully closed**: all three tts-v2 local engines lazy + TTL-unloaded
- [x] R4 guard: `unload` proven called exactly once on all six eviction paths × both cache classes
- [x] TASK-529 README errata applied; **DR-1 ratified as a recorded decision row**; its Status flipped to Review
- [x] All gates green with pasted real output, **each stating the `PYTHONPATH` pin used** (§9.2) — with one documented exception: a single stt-v2 e2e health-schema test fails, proven pre-existing at `30f6562c` (§9.6)
- [x] Runbook + comment deltas complete

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

Delivered end-to-end: 4.1–4.7, all in-scope gates green. Status → **Review**.

### 9.1 What landed

| Step | Outcome |
|---|---|
| 4.1 | `SyncModelCache` added. Rather than a copy-with-different-locks, the policy engine was extracted into a private `_CacheCore` that BOTH classes derive from — the ttl→lru→vram ordering, pin refcounts, all-pinned soft ceiling, eviction reason labels, `CacheStats`, clamp and VRAM probe are literally shared code, not parallel implementations. `ModelCache`'s public behaviour is unchanged (its pre-existing conformance suite is the guard). |
| 4.2 | R4 clause `test_unload_called_exactly_once_per_eviction_path[kind-path]` — 6 paths × 2 classes = 12 cases. Mutation-verified (below). |
| 4.3 | **D-08 closed.** `_ENTAILER_CACHE` module dict deleted; the entailer lives behind `SyncModelCache` (`cache="harness_minicheck"`), keyed by the same composite key. `load_minicheck_entailer`'s signature and return type are byte-identical, so `_atomic_fact_entailer` is untouched. Calibration moved INSIDE the cache factory, so it re-runs on every load including reloads. `harness.modelCache.*` bootstrap settings added. |
| 4.4 | **stt-v2 converged.** `models/cache.py` 567 → 470 lines; its ~150-line copy of the policy is gone, replaced by inheritance from the shared async cache. Parity gate passed with both pre-existing files UNMODIFIED. New `tests/unit/test_model_cache_contract.py` locks the injected loader map + `loader.unload()` release hook on every eviction path. |
| 4.5 | **D-09 fully closed.** IndicParler and IndicF5 joined Kokoro behind the shared cache (lazy load, TTL-unload, gauge→0, `configure_retention`, `sweep`). `main.py` passes `tts.modelCache.ttlSeconds` to all three. |
| 4.6 | TASK-529's three stale §2/§3.2 claims corrected in place; **DR-1 ratified** as a §10 decision row; its Status flipped Blocked → Review. |
| 4.7 | Runbook gains a cache inventory (§6a), the sync-vs-async note, the "the entailer lives in the WORKER process" operational fact, and a harness runbook entry. `apps/harness/README.md` gains a Model-retention section + the two new env knobs. The shared package README documents `SyncModelCache` and clauses 9–10. |

### 9.2 Gate evidence (each with the `PYTHONPATH` pin it was run under)

Worktree root `W = /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/.claude/worktrees/wf_90fdc7c8-c7f-1`.
Every pin was verified to resolve INSIDE the worktree before the gate ran, e.g.

```
$ PYTHONPATH=$W/apps/harness/src:$W/packages/py-runtime-models/src python -c "import harness, hope_runtime_models; print(...)"
resolved: .../wf_90fdc7c8-c7f-1/apps/harness/src/harness/__init__.py | .../wf_90fdc7c8-c7f-1/packages/py-runtime-models/src/hope_runtime_models/__init__.py
```

| Gate | Pin | Result |
|---|---|---|
| `pytest packages/py-runtime-models/tests/` | `$W/packages/py-runtime-models/src` | **74 passed in 0.06s** |
| `ruff check packages/py-runtime-models/{src,tests}/` | — | `All checks passed!` |
| `pytest apps/harness/src/harness/tests/` | `$W/apps/harness/src:$W/packages/py-runtime-models/src` | **901 passed, 1 warning in 20.75s** |
| `pytest .../temporal/test_replay_compat.py` | same | **10 passed** — file untouched |
| `ruff check apps/harness/src/` · `mypy apps/harness/src/` | `MYPYPATH=$W/packages/py-runtime-models/src` | `All checks passed!` · `Success: no issues found in 90 source files` (baseline: 1 error) |
| **stt-v2 PARITY** `pytest tests/unit/test_model_cache.py tests/unit/test_model_cache_ttl.py` | `$W/apps/stt-v2/src:$W/packages/py-runtime-models/src` | **40 passed in 0.85s**, both files unmodified |
| `pytest apps/stt-v2/tests/` | same | **2647 passed, 73 skipped, 3 xfailed, 1 failed** — the single failure is `test_health_endpoints_comprehensive.py::test_health_returns_200_with_complete_schema`, **proven pre-existing** by re-running it on a clean `git stash` of this ticket's changes (fails identically at `30f6562c`; it asserts an exact `/health` key set that TASK-525/529's `effective_config` block already broke). Not in this ticket's surface. |
| `ruff check apps/stt-v2/{src,tests}/` · `mypy apps/stt-v2/src/` | `MYPYPATH=$W/packages/py-runtime-models/src` | `All checks passed!` · `Success: no issues found in 123 source files` (baseline: 1 error) |
| `pytest apps/tts-v2/src/tts_v2/tests/` | `$W/apps/tts-v2/src:$W/packages/py-runtime-models/src` | **170 passed, 2 deselected in 0.43s** |
| `ruff check apps/tts-v2/src/` · `mypy apps/tts-v2/src/` | `MYPYPATH=$W/packages/py-runtime-models/src` | `All checks passed!` · **17 errors, down from a 20-error baseline** — all 17 pre-existing (missing optional ML stubs `kokoro`/`parler_tts`, `aclosing` type-var in `routing/router.py`, one numpy `Any` inside the untouched `_load_model`). Zero new. |
| `pytest apps/nlp/tests/` (adopter regression) | `$W/apps/nlp/src:$W/packages/py-runtime-models/src` | **173 passed in 0.61s** |
| `pytest apps/guardrail/src/guardrail/tests/` (adopter regression) | `$W/apps/guardrail/src:$W/packages/py-runtime-models/src` | **163 passed in 1.68s** |
| `pytest apps/smr/src/smr_v2/tests/` (clamp consumer) | `$W/apps/smr/src:$W/packages/py-runtime-models/src` | **947 passed, 32 deselected in 134.64s** |
| `uv lock --check` | — | `Resolved 475 packages in 12ms` — clean, no dependency change |

### 9.3 RED evidence (captured, not predicted)

1. **Contract suite** — first run after writing the parameterized clauses:
   `ImportError: cannot import name 'SyncModelCache' from 'hope_runtime_models'` (1 collection error).
2. **Harness** — 13 setup errors, `AttributeError: module 'harness.sensors.inferential.minicheck_entailer' has no attribute 'reset_entailer_cache'`.
3. **Worker sweeper** — 2 failures, `AttributeError: module 'harness.temporal.worker' has no attribute '_sweep_model_caches_once'`.
4. **tts-v2** — 10 failures / 13 passed: `TypeError: IndicF5Provider.__init__() got an unexpected keyword argument 'generate_factory'`. The `[kokoro]` variant of every parameterized clause passed on the same run, which is what proves the clauses themselves were correct against the reference implementation before Parler/F5 were touched.
5. **stt-v2** had no RED of its own by design — it is a refactor, and its RED-equivalent is the 40-test parity gate holding across the change (baseline captured green BEFORE the rewrite, re-run green after).

### 9.4 Mutation checks (proving the new guards actually bite)

Both mutations were applied, run, and reverted.

- **R4 guard.** Reintroduced TASK-529's exact defect — `_enforce_size_locked` evicts without returning the victim for unload:
  `FAILED ...[async-lru_overflow]` and `FAILED ...[sync-lru_overflow]`,
  `AssertionError: lru_overflow/sync: unload ran 0× for the evicted key`. Caught on **both** classes.
- **stt-v2 conformance.** Set the injected `unload=None`: **6 conformance clauses failed** (explicit evict, LRU overflow, memory-budget overflow, lazy TTL, sweep, clear) while all **40 parity tests still passed** — which is precisely why the new file exists: the parity suite never asserted that an evicted model is *released*.

### 9.5 Deviations from §3/§4 (with rationale)

| # | Deviation | Rationale |
|---|---|---|
| D-a | §3.1 said the sync cache would expose `sweep()` "for the harness FastAPI app's existing async sweeper". **There is no such sweeper, and the FastAPI app is the wrong process.** A periodic sweep was added to `temporal/worker.py` instead (60 s, cancelled on shutdown; body extracted as `_sweep_model_caches_once` so it is testable without sleeps). | The entailer is built inside a Temporal **activity**, so its GGUF is resident in the worker process. A sweeper in the FastAPI app would sweep an empty cache in the wrong process, leaving §3.1's stated goal ("released even when its key is never re-requested") unmet. `worker.py` is outside §4.3's file list but overlaps nothing in TASK-528. |
| D-b | The `unload` hook does **not** call `llama.close()`. Release is proven by a `weakref` + `gc.collect()` test instead. | An eviction can fire while an activity is still scoring with that entailer (TTL sweep is time-driven, and the sensor bound is 900 s). Closing the handle underneath a live caller would fault the clinical path. The llama handle is reachable only through the entailer's logit closure, so the cache dropping its reference is sufficient — and the weakref test proves the module pins nothing, which is the actual D-08 claim. Same posture as the tts providers ("the weights free on GC"). |
| D-c | §3.1 described `SyncModelCache` as "a small sibling". Implemented by extracting `_CacheCore` and deriving **both** classes from it. | §3.1 also required "policy is shared; only the concurrency primitive differs" and §7 flagged drift as the top risk. Inheritance from one core makes that structural rather than aspirational — there is no second copy of the policy to drift. |
| D-d | stt-v2's `ModelCache` **subclasses** the shared async `ModelCache` and overrides `get` to keep its long-standing PEEK semantics (`LoadedModel \| None`, never loads); `get_or_load` delegates to `super().get()` for the contract's single-flight/admission/unload machinery. | stt-v2's public API predates the contract and its callers (`health/api/routes.py`, `batch_service.py`) depend on `get` being a peek. Subclassing reuses the asyncio skin verbatim instead of copying ~80 lines of lock/in-flight code. The override is contained: nothing inside the shared core calls `self.get`. |
| D-e | `cache._cache` is now a live view (`_CacheEntryView` → `_BoundCacheEntry`) bridging `datetime` ⇄ monotonic, rather than the raw `OrderedDict`. | Mandatory to satisfy the §2.2 hard gate. `test_model_cache_ttl.py` mutates `entry.last_accessed` **in place** and expects the policy to observe it; the shared core stores monotonic floats. A snapshot copy would silently swallow those writes. Cost is ~60 contained lines; benefit is the parity gate passing unmodified, exactly as §2.2 demands. |
| D-f | `_max_models` / `_max_memory_mb` retained as property aliases over the core's `_max_size` / `_max_bytes_estimate`. | `tests/unit/test_effective_config_client.py::TestModelCacheAdoption` asserts on those private names. It is not in the frozen §2.2 parity gate, but the same rule applies — rework the code, not the test. It now also passes unmodified. |
| D-g | Added a PEP 561 `py.typed` marker to `packages/py-runtime-models` (+ `package-data` in its pyproject). | Not planned, but it is the root cause of a pre-existing defect: without the marker mypy treats every `from hope_runtime_models import …` as `import-untyped` and degrades everything downstream to `Any`. Fixing it took harness 1→0 and stt-v2 1→0 mypy errors and removed 3 of tts-v2's. Squarely inside this ticket's owned surface. |
| D-h | `configure_entailer_cache()` (harness) and `configure_retention()`/`sweep()` (IndicParler/IndicF5) ship **without a live caller**. | Harness has no effective-config polling client at all (only the duck-typed `settings.effective_config_client` used for weight-path resolution), and building one is a new subsystem outside the ownership manifest. This is the same posture TASK-529 shipped for nlp's `sweep_model_caches()` and Kokoro's `configure_retention()`. The server side (`resolveForService('harness'\|'tts-v2')` + the `<svc>.modelCache.*` descriptors) already exists; only the Python-side pull is absent. **Recorded as residue, not claimed as closed** — see §9.6. |

### 9.6 Known residue (deliberately not claimed)

> **ERRATA (2026-07-20, recorded by [TASK-535](../TASK-535-Retention-Client-Adoption/README.md) §2.1).** Item 1 below is **wrong about guardrail**, and items 1 and 2 are now **CLOSED**.
>
> **The correction.** Item 1 states E6's "global-admin-controlled" half is "satisfied for stt-v2/nlp/guardrail/smr". It was not satisfied for **guardrail**: verified against this ticket's own commit `9f3116fb`, `apps/guardrail/src/guardrail/core/dependencies.py:141,200` constructed both aux caches with `ttl_seconds=settings.model_cache_ttl_s` (env, `core/config.py:343`), and guardrail had **no `core/effective_config.py` module at all** — so it had no client to poll with, not merely no loop. The real gap was **three** services, not two. Guardrail specifically was an unfulfilled TASK-529 §4.4 promise ("effective-config wiring for `model_cache_ttl_s`/`max_models`"), i.e. a *partial implementation* under the §2.5 Completion & Cleanup Doctrine rather than deliberate residue.
>
> **Why it was missed here:** guardrail was out of this ticket's ownership manifest, and it *does* consume the control plane for a different concern (model IDENTITY, via the `AiTaskDefault` registry — `_resolve_aux_model_id`). "Guardrail reads the control plane" was true; "guardrail reads control-plane *retention*" was not, and the two were conflated.
>
> **Status now.** TASK-535 shipped per-service effective-config clients for guardrail, harness and tts-v2, each reconfiguring **live** caches (not only newly constructed ones). All six services take retention from the control plane, closing item 1. Item 2 is fixed there too — the assertion now checks required keys are present rather than pinning an exact set, so the next additive `/health` field does not re-break it.

1. ~~**No control-plane pull in harness/tts-v2.**~~ **CLOSED by TASK-535** — and see the errata above: the claim was also wrong about guardrail. The retention *seams* existed and were tested; nothing called them because none of the three services had an effective-config client. Runtime retention used the bootstrap env values (`HARNESS_MODEL_CACHE_*`, `TTS_MODEL_CACHE_TTL_SECONDS`, `GUARDRAIL_V2_MODEL_CACHE_TTL_S`) until those clients landed.
2. ~~**stt-v2 e2e `test_health_returns_200_with_complete_schema`**~~ **CLOSED by TASK-535 (R4)** — a stale exact-key-set assertion vs the `effective_config` block added by TASK-525/529; fixed to tolerate additive keys while still asserting the required ones.
3. **`SyncModelCache` refuses async unload hooks** (logs `async_unload_hook_unsupported` and closes the coroutine) rather than supporting them. There is no loop to await on; silently dropping them would be the D-08 failure mode all over again.

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket authored from the TASK-529 execution outcome. Number confirmed against plan §325's explicit reservation. Scope: D-08 sync/async fork (resolved as `SyncModelCache` with rationale + rejected alternative recorded), stt-v2 convergence with a hard parity gate, D-09 completion, contract-level `unload`-hook guard for the two defects TDD caught in TASK-529, and TASK-529 README errata incl. **DR-1 ratification** of the `<svc>.modelCache.*` key grammar over the superseded §3.2 `models.retention.*`. Status Pending — awaiting owner approval per rule 01 Phase 3 gate. |
| 2026-07-20 | **Implementation pass — all of 4.1–4.7 delivered; Status → Review.** `SyncModelCache` added by extracting a shared `_CacheCore` both cache classes derive from (policy is shared code, not a second copy). R4's six-path × two-class unload guard added and mutation-verified against TASK-529's exact defect. **D-08 closed**: the harness `_ENTAILER_CACHE` module dict is gone, the entailer is bounded/evictable/re-calibrated-on-reload, `load_minicheck_entailer` keeps its exact sync signature, and a periodic sweep runs in the Temporal **worker** (where the GGUF actually lives — §3.1 assumed the FastAPI app; deviation D-a). **stt-v2 converged** with its two pre-existing test files passing UNMODIFIED (40/40), plus a new conformance file that catches a dropped release hook the parity suite cannot see. **D-09 fully closed**: IndicParler + IndicF5 joined Kokoro under TTL-unload. TASK-529's errata applied and **DR-1 ratified** as a decision row there. Eight deviations recorded in §9.5; two residue items in §9.6 (no control-plane *pull* in harness/tts-v2 yet; one pre-existing stt-v2 e2e failure). |
| 2026-07-20 | **Errata + residue closure (recorded by TASK-535).** §9.6 item 1 was **factually wrong about guardrail**: it reported E6's global-admin-controlled half as satisfied for stt-v2/nlp/guardrail/smr, but guardrail took retention from env (`dependencies.py:141,200` → `settings.model_cache_ttl_s`) and had **no effective-config module at all** — the gap was three services, not two, and guardrail was an unfulfilled TASK-529 §4.4 promise (a partial implementation under §2.5 doctrine, not deliberate residue). The conflation was between guardrail consuming the control plane for model IDENTITY (true) and for RETENTION (false). TASK-535 shipped clients for guardrail/harness/tts-v2 that reconfigure **live** caches, closing §9.6 items 1 and 2. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end; redundant implementations are converged and deleted. This ticket exists to satisfy that doctrine for TASK-529's residue. |
