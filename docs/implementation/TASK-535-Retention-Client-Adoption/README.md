# TASK-535 — Retention Control-Plane Client Adoption (guardrail, harness, tts)

- **Status**: Review
- **Type**: feature (completion of a partial implementation)
- **Program**: Phase 3 residue of the [2026-07-20 agentic platform program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) · frozen design **AD-4** · closes the residue recorded in [TASK-530](../TASK-530-Lifecycle-Convergence-Tail/README.md) §9.6 and the unfinished half of [TASK-529](../TASK-529-Model-Lifecycle-Retention/README.md) §4.4
- **Numbering**: verified 2026-07-20 — `docs/implementation/` holds TASK-523…534 (the program plan's full allocation, §6: *"suggested TASK-523 … TASK-534"*); 535 is the next free number. Not one of the plan's reserved slots.
- **Size**: M · **Lanes**: E (guardrail, harness, tts) + a one-line D fix
- **Dependencies**: TASK-529 + TASK-530 (both merged: `30f6562c`, `9f3116fb`). **No dependency on TASK-524/525 work remaining** — the server side is already complete (§2.2). **No file overlap with TASK-531**, which is in flight in another session (§4.2).
- **Owner decisions carried in**: **OD-5** (default retention TTL 600 s, clamped 60–3600 s)

---

## 1. Requirement Analysis

Owner expectation **E6**: *"All models load on request, retained max 1 h / min 1 min (**global-admin-controlled** retention), evicted sooner under VRAM pressure."*

TASK-529 and TASK-530 delivered the load-on-request, TTL-eviction, and VRAM halves across every service. The **global-admin-controlled** half is where the work stopped short: three of six services still take their retention from environment variables, so changing `<svc>.modelCache.ttlSeconds` in the admin console has no effect on them. A knob that silently does nothing is worse than an absent knob — it is exactly the D-07 failure mode this program already paid for once.

| Req | Meaning | Closes |
|---|---|---|
| R1 | **guardrail** consumes control-plane retention (it has no effective-config client at all today) | TASK-529 §4.4, shipped env-only |
| R2 | **harness** consumes control-plane retention, in the **worker** process where the entailer actually lives | TASK-530 §9.6 residue |
| R3 | **tts** consumes control-plane retention for all three local engines | TASK-530 §9.6 residue |
| R4 | The stale `/health` schema test in stt stops failing the suite | pre-existing, proven at `84417988` |
| R5 | The intermittent `packages/applications` flake is identified (diagnose-only, §3.5) | test-suite trust |

**Explicitly out of scope**: any new settings key (all six already resolve server-side — §2.2); the retention *policy* (unchanged, OD-5); concurrency knobs; vLLM sleep mode; anything in TASK-531's surface.

---

## 2. Current State Evaluation (code-verified 2026-07-20 against `9f3116fb`)

### 2.1 The real matrix — and the correction to TASK-530

TASK-530 §9.6 reported "admin-controlled for stt/nlp/guardrail/smr, wired-but-not-polled for harness/tts". **That is wrong about guardrail.** Verified by reading each service:

| Service | Retention source today | Admin-controlled? | Evidence |
|---|---|---|---|
| stt | control plane | ✅ | `models/cache.py:55-63` `set_retention_refresher` installed at startup, cache calls `_refresh_retention` (TASK-525) |
| nlp | control plane | ✅ | `dependencies.py:156-173` `_current_retention` / `_retention_kwargs()` (TASK-529 D-07) |
| smr | control plane | ✅ | live request path: `api/endpoints/generate.py:197` `Depends(get_runtime_limits)` → `core/dependencies.py:103` `refresh_runtime_limits` → `services/runtime_limits.py:131` `apply_provider_retention` |
| **guardrail** | **env only** | **❌** | `core/dependencies.py:141,200` pass `ttl_seconds=settings.model_cache_ttl_s` (`core/config.py:343`, default 600). **No `effective_config.py` module exists** and `dependencies.py` imports no effective-config client. |
| **harness** | **env only** | **❌** | seam `configure_entailer_cache` exists (TASK-530) with **no caller**; no `effective_config.py` module |
| **tts** | **env only** | **❌** | seams `configure_retention` exist on kokoro/indic_f5 (TASK-529/530) with **no caller**; no `effective_config.py` module |

So it is **three** services, not two. Under the plan's §2.5 Completion & Cleanup Doctrine, guardrail is a *partial implementation* (TASK-529 §4.4 explicitly promised "effective-config wiring for `model_cache_ttl_s`/`max_models`" and delivered the env fallback only) and must be finished end-to-end.

### 2.2 The server side is already complete — this is a client-only ticket

`packages/applications/src/services/effective-config/effective-config.service.ts:106-117` resolves the retention subset for **all six** services, with an explicit comment that TASK-525's reserved subsets "are now filled, in the same shape, so clients already polling them see fields appear rather than change meaning":

```ts
case 'guardrail': return { ...base, retention: await this.resolveRetention('guardrail') };
case 'harness':  return { ...base, retention: await this.resolveRetention('harness') };
case 'tts':   return { ...base, retention: await this.resolveRetention('tts') };
```

`resolveRetention` (`:144-161`) reads `<svc>.modelCache.{ttlSeconds,maxModels,vramBudgetMb}`. **No gateway change, no new settings key, no migration.** Note the key prefix for tts is **`tts`**, not `tts` — the service param and the key namespace differ, and the client must not assume they match.

### 2.3 The client pattern to copy (do not invent a new one)

Three implementations already exist and are deliberately duplicated per service — `stt/core/effective_config.py:14` states the intent: *"single-flight refresh, read-triggered. Duplicated per service on purpose."* Properties (from the stt/nlp/smr trio):

- **Read-triggered, not a background poller** — `smr/core/effective_config.py:18`: *"a service that never reads never polls."* TTL-cached (~60 s) with single-flight collapse of concurrent expirers, jittered so services don't form a thundering herd.
- **Fail-safe**: any fetch error logs and falls back to the env value; a config refresh must never break a request (`runtime_limits.py:132-133` catches broadly by design).
- Negative-cached so a down gateway doesn't produce a per-request stampede.

**Follow this pattern per service.** Do NOT hoist it into `packages/py-runtime-models` — the duplication is a recorded decision, and this ticket is not the place to relitigate it.

### 2.4 Process placement — the harness subtlety

The MiniCheck entailer is constructed inside a **Temporal activity** (`temporal/activities.py:390`), so the GGUF is resident in the **worker** process, not the FastAPI app. TASK-530 already established this by putting the cache sweep in `temporal/worker.py`. The retention refresh must live in the **same process as the cache it configures** — a poll in the FastAPI app would reconfigure a cache that holds nothing.

tts and guardrail are ordinary FastAPI apps, so the stt lifespan-installed-refresher shape applies directly.

### 2.5 R4 — the stale health-schema test

`apps/stt/tests/e2e/test_health_endpoints_comprehensive.py::TestHealthEndpointE2E::test_health_returns_200_with_complete_schema` asserts an **exact** key set and now sees an extra `effective_config` key added by TASK-525's work. Proven pre-existing: it fails on a pristine worktree at `84417988`, before any of TASK-528/529/530. One-line fix; the file is untouched by TASK-531.

### 2.6 R5 — the applications flake

`pnpm --filter @arcaai/applications test` failed once in roughly three full runs (6561 tests) and passed 5/5 direct `vitest` runs; TASK-529's new descriptor tests were stable 5/5, so it is **not** in the new work. The visible suite logs are full of SSE/timer/Redis-ish activity (`SSE stream ending`, job status transitions) — the usual flake sources. **Diagnose-only in this ticket** (§3.5).

---

## 3. Architecture & Approach

### 3.1 Per-service client (R1–R3)

Each service gains `core/effective_config.py` modeled on `apps/nlp/src/nlp/core/effective_config.py` (the smallest of the three exemplars), plus wiring:

| Service | Client install point | Applies to |
|---|---|---|
| guardrail | `main.py` lifespan → client on `app.state`; `core/dependencies.py` resolves retention when building each `ModelCache` (mirroring nlp's `_retention_kwargs()`) | GLiNER cache + MiniCheck scorer cache |
| harness | **`temporal/worker.py`** — alongside the existing `_sweep_model_caches_once`; calls `configure_entailer_cache(...)` on the same interval | MiniCheck entailer `SyncModelCache` |
| tts | `main.py` lifespan → refresher; calls `configure_retention(...)` on each local provider | Kokoro + IndicParler + IndicF5 |

Env vars (`GUARDRAIL_V2_MODEL_CACHE_TTL_S`, `HARNESS_MODEL_CACHE_*`, `TTS_MODEL_CACHE_*`) remain the documented **bootstrap fallback** — unchanged defaults, so a service with no gateway reachable behaves exactly as today.

### 3.2 Caches already resident must be reconfigured, not just new ones

The failure mode to avoid: applying retention only at cache *construction*, so a control-plane change never reaches a cache that is already alive. Both shared cache classes expose `configure()` for exactly this (TASK-529 §3.1 clause 7, "hot reconfiguration ... without dropping resident entries"). Each service's refresh path calls `configure()` on the **live** cache instance. This is the explicit acceptance criterion in §5.

### 3.3 Clamp stays double-enforced

`clamp_cache_ttl_seconds` is re-applied client-side even though the registry validates — defense in depth, per TASK-529 §3.2. A hostile or buggy control-plane value must not push a cache outside `[60, 3600]`.

### 3.4 tts key-namespace trap

The gateway maps service `tts` → key prefix `tts` (§2.2). A client that requests `service=tts` gets a 4xx/empty; one that expects keys named `tts.modelCache.*` finds nothing. Both directions are a silent no-op — the exact class of bug this ticket exists to remove. Pin it with a test.

### 3.5 R5 scope guard (diagnose-only)

**A concurrent session is actively editing `packages/applications/src/services/stt/pipeline/**` and `apps/admin-console/src/features/audio-pipelines/**` for TASK-531.** For R5: reproduce by looping the full suite, identify the failing test by name and root cause, and **report**. Apply a fix ONLY if it lies outside TASK-531's paths (§4.2); otherwise record the finding for that ticket's owner. Do not "fix" a flake by weakening an assertion.

---

## 4. Implementation Plan

| Step | Work | Files |
|---|---|---|
| 4.1 | **guardrail (R1)** — NEW `core/effective_config.py`; UPDATE `main.py` (lifespan install), `core/dependencies.py:135-145,195-205` (resolved retention into both caches + `configure()` on live instances), `core/config.py` (docstring: bootstrap fallback only) | `apps/guardrail/src/guardrail/**` |
| 4.2 | **harness (R2)** — NEW `core/effective_config.py`; UPDATE `temporal/worker.py` (refresh beside the existing sweep), `sensors/inferential/minicheck_entailer.py` only if `configure_entailer_cache` needs a caller-facing tweak, `core/config.py` docstring | `apps/harness/src/harness/**` |
| 4.3 | **tts (R3)** — NEW `core/effective_config.py`; UPDATE `main.py` lifespan, `providers/{kokoro,indic_parler,indic_f5}.py` only where `configure_retention` needs wiring, `core/config.py` docstring | `apps/tts/src/tts/**` |
| 4.4 | **R4** — fix the stale exact-key assertion | `apps/stt/tests/e2e/test_health_endpoints_comprehensive.py` |
| 4.5 | **R5** — diagnose the flake per §3.5 | report only (+ fix iff outside TASK-531 paths) |
| 4.6 | **Docs** — runbook matrix updated to show all six services control-plane-driven; TASK-530 §9.6 residue marked closed; **correct TASK-530's guardrail claim** (§2.1) as a recorded errata row | `docs/operations/inference/model-retention.md`, `docs/implementation/TASK-530-*/README.md` |

### 4.2 Ownership manifest — exclusive, and disjoint from TASK-531

**Owned**: `apps/guardrail/src/guardrail/**` · `apps/harness/src/harness/**` · `apps/tts/src/tts/**` · `apps/stt/tests/e2e/test_health_endpoints_comprehensive.py` · `docs/operations/inference/model-retention.md` · the two ticket READMEs.

**FORBIDDEN — another session is editing these right now**: `packages/applications/src/services/stt/pipeline/**` · `packages/applications/src/services/tenant/**` · `apps/admin-console/src/features/audio-pipelines/**` · `apps/api/src/modules/pipeline/**` · `apps/api/src/modules/tenant/**` · `packages/database/src/prisma/**` · `packages/domains/src/**/AsrPipeline*`. Touching any of these means editing over a concurrent agent's uncommitted work.

**No gateway/TS source change is needed at all** (§2.2) — if you believe otherwise, STOP and report.

---

## 5. TDD Plan (RED first — paste real failing output into §9)

Per service (`guardrail`, `harness`, `tts`), the same four clauses:

1. `test_retention_comes_from_control_plane` — stubbed client returns `ttlSeconds: 900` → the cache's effective TTL is 900, **not** the env default. RED today (no client exists).
2. `test_live_cache_reconfigured_not_just_new_ones` — build the cache, load an entry, THEN change the stubbed control-plane value → the resident cache reports the new TTL and **keeps its resident entry** (§3.2).
3. `test_gateway_unreachable_falls_back_to_env` — client raises → env value used, no exception escapes to the caller, warning logged.
4. `test_clamp_applied_client_side` — control plane returns `7200` and `30` → clamped to `3600` / `60` (§3.3).

Plus:

- **harness only**: `test_retention_refresh_runs_in_worker_process` — the refresh is registered on the worker's periodic path, not the FastAPI lifespan (§2.4). Hermetic — no live Temporal. `test_replay_compat.py` must stay **untouched and green**.
- **tts only**: `test_service_param_and_key_namespace` — the client requests `service=tts` while the keys resolve under `tts` (§3.4).
- **R4**: the health test passes; assert the schema check is now resilient to additive keys rather than re-pinning a new exact set (otherwise it breaks again on the next additive field).

### 5.1 Gates (state the `PYTHONPATH` pin used with each)

`pnpm py:guardrail:test|lint|typecheck` · `pnpm py:harness:test|lint|typecheck` · `pnpm py:tts:test|lint|typecheck` · `pnpm py:stt:test` (expect **0 failures** after R4) · `pytest packages/py-runtime-models/tests/` (unchanged, 74) · `uv lock --check`.

> **Worktree hazard (verified 2026-07-20).** `arcaenv`'s editable installs are `.pth` files hardcoding the MAIN checkout, so a bare `pnpm py:<svc>:test` in a worktree collects your test files but imports **main-tree source** — green while proving nothing. Export `PYTHONPATH=<worktree>/apps/<svc>/src:<worktree>/packages/py-runtime-models/src` before every gate and verify it resolves inside the worktree. A gate reported without its pin is not evidence.

House constraints: fake clocks, no `sleep`; NVML stubbed; seed randomness **inside the test body** (pytest-randomly reseeds numpy after fixtures); harness suite stays hermetic.

---

## 6. Acceptance & Definition of Done

- [x] All six services take retention from the control plane; a TTL change reaches guardrail, harness and tts within one refresh window **with no redeploy** (stub-integration test per service) — §9.1, §9.2
- [x] Live, already-resident caches are reconfigured — not only newly constructed ones (§3.2) — §9.3, `test_live_cache_reconfigured_not_just_new_ones` ×3
- [x] Gateway unreachable ⇒ env fallback, no request-path exception, warning logged — per service (`test_gateway_unreachable_falls_back_to_env` ×3)
- [x] Clamp `[60, 3600]` enforced client-side in all three (`test_clamp_applied_client_side[7200-3600]` / `[30-60]` ×3)
- [x] harness refresh proven to run in the **worker** process; replay fixtures untouched and green; suite still hermetic — `test_retention_refresh_runs_in_worker_process`; 908 passed with `test_replay_compat.py` unmodified
- [x] tts `service=tts` ⇄ key-prefix `tts` pinned by test (`test_service_param_and_key_namespace`)
- [ ] `pnpm py:stt:test` reports **0 failures** (R4), and the assertion tolerates future additive keys — **half done**: R4 itself is fixed and additive-tolerant (2 failures → 1), but the suite is not at 0 because of pre-existing, out-of-manifest `test_vad_smart_uses_silero_service_when_available` (§9.4 P-1)
- [x] R5 flake named with a root cause, or explicitly reported as not-reproduced after a stated number of runs — **not reproduced in 8 runs** (§9.5)
- [x] Zero files touched from the §4.2 forbidden list — proven by `git status --porcelain` (§9.6)
- [x] Runbook matrix updated; TASK-530 §9.6 residue closed **and its guardrail claim corrected** as an errata row
- [x] All gates green with pasted real output, each stating its `PYTHONPATH` pin — §9.2 (two documented pre-existing exceptions, §9.4 P-1/P-2)

## 7. Risks & Rollback

| Risk | Mitigation / rollback |
|---|---|
| Retention applied at construction only ⇒ knob silently dead for live caches | §3.2 is an explicit acceptance criterion with its own per-service test (clause 2) |
| A refresh in the request path adds latency or a failure mode | Read-triggered + TTL-cached + single-flight + negative-cached, copying the proven trio; fail-safe catch means a config error never breaks a request |
| harness refresh placed in the FastAPI app ⇒ reconfigures an empty cache | §2.4 called out; a dedicated test asserts worker-process placement |
| tts service/key namespace mismatch ⇒ silent no-op | §3.4 + dedicated test |
| Collision with the in-flight TASK-531 session | §4.2 forbidden list; no TS/gateway change is needed at all |
| Weakening the health assertion hides a real regression | R4 must tolerate *additive* keys while still asserting the required ones are present |

## 8. References

- [TASK-530](../TASK-530-Lifecycle-Convergence-Tail/README.md) §9.6 (residue) · [TASK-529](../TASK-529-Model-Lifecycle-Retention/README.md) §3.2, §4.4
- Program plan §2.5 Completion & Cleanup Doctrine, §8 OD-5 · findings §3-E6, GAP-L2
- Client exemplars: `apps/nlp/src/nlp/core/effective_config.py` (smallest), `apps/stt/src/stt/core/effective_config.py`, `apps/smr/src/smr/{core/effective_config.py,services/runtime_limits.py}`
- Server contract: `packages/applications/src/services/effective-config/effective-config.service.ts:106-161`
- Rules: `.claude/rules/06-python-services.md` · Repo memory: worktree `.pth` hazard; pytest-randomly numpy reseed

## 9. Implementation Summary

Delivered R1–R4 in full; R5 is reported as **not reproduced** (§9.5). No TypeScript, gateway, database or settings-registry change was needed — §2.2 held exactly as written.

### 9.1 Files

**New — one client per service (3), structurally consistent with the `nlp` exemplar:**

| File | Contents |
|---|---|
| `apps/guardrail/src/guardrail/core/effective_config.py` | `EffectiveConfigSnapshot.retention()` + `EffectiveConfigClient` |
| `apps/harness/src/harness/core/effective_config.py` | same + `build_effective_config_client()` (derives the gateway base from the existing `api_base_url` — **no new harness env var**) |
| `apps/tts/src/tts/core/effective_config.py` | same + `refresh_model_cache_retention(app_state)`; `retention()` yields `ttl_seconds` only (a tts provider bounds one pipeline, so `maxModels` is meaningless there) |

All three keep the recorded per-service duplication (§2.3, OD-3) and identical semantics: read-triggered, TTL-cached (60 s ±10 % jitter), single-flight, negative-cached, and total-degradation fail-safe.

**New — tests (3):** `apps/guardrail/src/guardrail/tests/test_effective_config_retention.py` (9) · `apps/harness/src/harness/tests/unit/test_effective_config_retention.py` (7) · `apps/tts/src/tts/tests/unit/test_effective_config_retention.py` (8). **24 new tests**, all four §5 clauses per service plus the two per-service extras.

**Modified (9):**

| File | Change |
|---|---|
| `guardrail/core/dependencies.py` | `_retention_kwargs()` (construction path) + `apply_model_cache_retention()` (live path) + `refresh_model_cache_retention()`; both caches built from resolved retention; read-trigger in `pinned_gliner_provider` and `acquire_groundedness_verifier` |
| `guardrail/main.py` | lifespan installs the client on `app.state` (no I/O at boot) |
| `guardrail/core/config.py` | `gateway_url` added; retention docstring corrected — the "control plane" promise was unfulfilled until now |
| `harness/temporal/worker.py` | `_refresh_model_cache_retention_once()`, `_effective_config_client()`, `_model_cache_housekeeping_once()`; the periodic loop now refreshes **then** sweeps |
| `tts/main.py` | lifespan installs the client |
| `tts/api/endpoints/speech.py` | read-trigger before routing |
| `tts/core/config.py` | `gateway_url` added; docstring corrected |
| `apps/stt/tests/e2e/test_health_endpoints_comprehensive.py` | **R4** — exact-key-set assertion → required-keys-subset (`required_keys <= set(data.keys())`) |
| `turbo.json`, `.env.example` | register `GUARDRAIL_V2_GATEWAY_URL`, `TTS_GATEWAY_URL` |

**Docs:** `docs/operations/inference/model-retention.md` (new §2a adoption matrix showing all six services control-plane-driven, the `tts`⇄`tts` prefix warning, harness worker-placement note, a "the knob did nothing" runbook entry) · `TASK-530/README.md` (§9.6 errata block + change-history row, per §4.6).

### 9.2 Gates — all with their `PYTHONPATH` pin

`conda run` is sandbox-blocked in this environment, so gates ran the **same interpreter** the `py:*` scripts wrap (`~/miniconda3/envs/arcaenv/bin/python -m pytest …`) with the arguments from `package.json`. `W` = this worktree root.

**Pin verified first** — all four packages resolve inside the worktree, confirming the `.pth` hazard is real and neutralized:

```
$ PYTHONPATH=$W/apps/guardrail/src:$W/apps/harness/src:$W/apps/tts/src:$W/packages/py-runtime-models/src python -c "import guardrail, harness, tts, hope_runtime_models; ..."
guardrail -> .../wf_432a52e1-91e-1/apps/guardrail/src/guardrail/__init__.py
harness -> .../wf_432a52e1-91e-1/apps/harness/src/harness/__init__.py
tts -> .../wf_432a52e1-91e-1/apps/tts/src/tts/__init__.py
hope_runtime_models -> .../wf_432a52e1-91e-1/packages/py-runtime-models/src/hope_runtime_models/__init__.py
```

| Gate | `PYTHONPATH` pin | Result |
|---|---|---|
| `pytest apps/guardrail/src/guardrail/tests/` | `$W/apps/guardrail/src:$W/packages/py-runtime-models/src` | **172 passed** (baseline 163 + 9 new) |
| `pytest apps/harness/src/harness/tests/` | `$W/apps/harness/src:$W/packages/py-runtime-models/src` | **908 passed** (baseline 901 + 7 new) |
| `pytest apps/tts/src/tts/tests/` | `$W/apps/tts/src:$W/packages/py-runtime-models/src` | **178 passed, 2 deselected** (baseline 170 + 8 new) |
| `pytest apps/stt/tests/` | `$W/apps/stt/src:$W/packages/py-runtime-models/src` | **1 failed, 2682 passed, 38 skipped, 3 xfailed** — down from 2 failed at baseline; see §9.4 |
| `pytest packages/py-runtime-models/tests/` | `$W/packages/py-runtime-models/src` | **74 passed** (unchanged) |
| `ruff check apps/{guardrail,harness,tts}/src/` | n/a | **All checks passed!** ×3 |
| `mypy --config-file apps/<svc>/pyproject.toml apps/<svc>/src/` | per-service src + runtime-models | guardrail **Success, 31 files** · harness **Success, 91 files** · tts **17 errors in 7 files — all pre-existing** (§9.4) |
| `uv lock --check` | n/a | `Resolved 475 packages` — no dependency change (`httpx`/`structlog` already declared by all three) |
| `pnpm --filter @arcaai/applications test` | n/a | **6524 passed, 4 skipped** — ×8 runs (§9.5) |

RED was captured before any implementation: **9 + 7 + 8 = 24 failing tests** (`ImportError: cannot import name 'refresh_model_cache_retention'`, `ModuleNotFoundError: No module named 'tts.core.effective_config'`, `assert hasattr(worker, '_refresh_model_cache_retention_once')` → False).

### 9.3 The §3.2 criterion, per service

Each service's clause-2 test builds a cache, **loads a resident entry**, then moves the stubbed control-plane value twice and asserts the *same live instance* follows while keeping its resident model:

- **guardrail** — a `ModelCache` placed on `app_state` before any refresh: `600 → 900 → 1800`, `resident_models == 1`, `keys == ['resident-model']` throughout.
- **harness** — a real `load_minicheck_entailer()` through the `_build_entailer` seam: `600 → 900 → 1800`, resident entailer retained.
- **tts** — Kokoro after a real `synthesize()` has loaded its pipeline: `600 → 900 → 1800`, `resident_models == 1`.

Reconfiguration goes through the shared `_CacheCore.configure()`, which by contract adopts limits **without purging** — an admin moving the slider never evicts a model mid-request.

### 9.4 Deviations & pre-existing failures

| # | Item | Rationale |
|---|---|---|
| D-1 | **Two new env vars** (`GUARDRAIL_V2_GATEWAY_URL`, `TTS_GATEWAY_URL`), which §4.1 did not list | Neither service had *any* gateway address; a pull client cannot exist without one. These are bootstrap **transport**, not config authority — the same distinction `nlp/core/config.py` draws for `NLP_GATEWAY_URL`. Registered in `turbo.json#globalEnv` + `.env.example` per rule 09. Harness needed none (`api_base_url` + `/api/v1`). |
| D-2 | harness refresh is **periodic** (60 s worker tick), not read-triggered | Mandated by §2.4/§4.1: the worker has no request path. The client keeps its TTL/single-flight/negative-cache semantics, so it is structurally consistent with the other five; only the trigger differs. |
| D-3 | tts's `retention()` returns `ttl_seconds` only | Its providers bound exactly one pipeline each (`maxModels` is 1 by construction — runbook §6a), and `configure_retention` accepts only a TTL. Parsing `maxModels` to discard it would be dead code. |
| D-4 | Gates ran `~/miniconda3/envs/arcaenv/bin/python -m pytest` instead of `pnpm py:*:test` | `conda run` is blocked by this environment's sandbox. Same interpreter, same env, same pytest arguments — and the `PYTHONPATH` pin is what makes the run meaningful either way. |
| P-1 | `apps/stt/tests/integration/test_new_services_integration.py::TestVADPreprocessingIntegration::test_vad_smart_uses_silero_service_when_available` still fails | **Pre-existing at `9f3116fb`** (present in the baseline run before any edit) and unrelated to retention: it patches `stt.vad.silero_service.get_vad_service` and the production path never calls it (`Expected 'detect_speech' to have been called once. Called 0 times.`). **Outside this ticket's ownership manifest** (§4.2 owns only `test_health_endpoints_comprehensive.py` in stt), so it was left untouched rather than fixed opportunistically. This is why the §6 "0 failures" box is unticked. |
| P-2 | tts mypy: 17 errors in 7 files | **Pre-existing** — proven by stashing all changes and re-running: 17 before, 17 after, same 7 files (`core/audio.py`, `providers/azure_speech.py`, `providers/indic_parler.py`, `providers/kokoro.py`, `routing/{chunking,router,sentence_adapter}.py`). None is in a file this ticket created or modified; the new module added 1 checked file and 0 errors. |

### 9.5 R5 — not reproduced (diagnose-only, §3.5)

**Result: not reproduced in 8 consecutive full-suite runs.** Every run: `Test Files 316 passed | 1 skipped (317)` · `Tests 6524 passed | 4 skipped (6528)`, exit 0.

Worth recording for whoever picks this up: the worktree needed `pnpm install` **and** `pnpm turbo build --filter=@arcaai/applications...` before the suite would run at all — without built workspace `dist` output, 229 of 317 files fail at import with `Failed to resolve entry for package "@arcaai/domains"` / `"@arcaai/types"`. That is a *stale-artifact* failure mode with a very different signature from the reported flake, but it is a plausible source of "failed once in three runs" if a run happened while another process was mid-rebuild of `@arcaai/database`/`@arcaai/domains` (they are `rimraf dist && tsc`, so `dist` is briefly absent). Nothing was changed in `packages/applications`; no assertion was weakened.

### 9.6 Forbidden-path compliance (§4.2)

```
$ git status --porcelain
 M .env.example
 M apps/guardrail/src/guardrail/core/config.py
 M apps/guardrail/src/guardrail/core/dependencies.py
 M apps/guardrail/src/guardrail/main.py
 M apps/harness/src/harness/temporal/worker.py
 M apps/stt/tests/e2e/test_health_endpoints_comprehensive.py
 M apps/tts/src/tts/api/endpoints/speech.py
 M apps/tts/src/tts/core/config.py
 M apps/tts/src/tts/main.py
 M docs/implementation/TASK-530-Lifecycle-Convergence-Tail/README.md
 M docs/operations/inference/model-retention.md
 M turbo.json
?? apps/guardrail/src/guardrail/core/effective_config.py
?? apps/guardrail/src/guardrail/tests/test_effective_config_retention.py
?? apps/harness/src/harness/core/effective_config.py
?? apps/harness/src/harness/tests/unit/test_effective_config_retention.py
?? apps/tts/src/tts/core/effective_config.py
?? apps/tts/src/tts/tests/unit/test_effective_config_retention.py
?? docs/implementation/TASK-535-Retention-Client-Adoption/
```

Zero entries under `packages/applications/src/services/{stt/pipeline,tenant}/**`, `apps/admin-console/src/features/audio-pipelines/**`, `apps/api/src/modules/{pipeline,tenant}/**`, `packages/database/src/prisma/**`, or `packages/domains/src/**/AsrPipeline*`. **No TypeScript source file was modified at all** — §2.2 held, so the two `turbo.json` / `.env.example` lines are the only non-Python, non-docs edits.

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | **Findings closeout.** (a) **R4 hardened.** A concurrent session independently fixed the same stale `/health` assertion by adding `effective_config` to the exact key set — correct today, but it would break again on the next additive diagnostics block, which is how this test broke in the first place. Converged on the required-keys **subset** form (`required_keys <= set(data.keys())`); a missing key is still a regression, an extra one is not. Single implementation, per §2.5 doctrine. (b) **New defect found and fixed — `test_persist_if_needed_respects_interval` depended on host uptime.** `StreamSession.persist_if_needed` (`streaming/session.py:385-390`) compares against `time.monotonic()`, which is time **since boot**, while `_last_persisted_at` defaults to `0.0`. With the test's `_persist_interval_s = 1000`, the first call persisted *only if the machine had been up ≥ ~16.7 min* — so the suite failed on any recently booted host and passed later the same day with no code change. Diagnosed by observing `time.monotonic() = 887s` right after a reboot; the test failed 3/3 at that uptime and passed 3/3 after backdating `_last_persisted_at` explicitly. This also retro-explains the earlier "1 failed / 2647 passed" stt runs recorded in TASK-530 §9.6. (c) **R5 characterized, not closed.** Reproduced twice more (once 1 failure, once **7 at once**) across 9 `pnpm --filter @arcaai/applications test` runs, and **never** across ~14 direct `npx vitest run` runs — although the package script is literally `vitest run --passWithNoTests`, so it is not a turbo/build difference. Both failures occurred while a concurrent session was running heavy builds; names were never captured. **No root cause claimed and nothing weakened** — open for a dedicated ticket with a load-correlated repro harness. (d) **Second environmental flake recorded**: harness `test_doc_workflow.py` fails on a Temporal *test-server startup* race (`tcp connect error … Connection refused`) — 1 fail then 43 pass on re-run, 3/3 clean on the base commit. Infrastructure, not logic. (e) **Stale commit hashes corrected** in this README and TASK-530's: the branch was rewritten by the concurrent session, orphaning `985ead2d`/`8757ee3d`; content verified byte-identical in their replacements `30f6562c`/`9f3116fb` before the references were repointed. (f) TASK-535's own P-1 (stt VAD integration test) **did not reproduce** — passes 3/3 isolated and in two full-suite runs; stt is now **2687 passed, 0 failed**, twice. |
| 2026-07-20 | **Implementation pass — R1–R4 delivered; Status → Review.** Three per-service effective-config clients shipped (guardrail, harness, tts), structurally consistent with the `nlp` exemplar and with each other: read-triggered, TTL-cached with jitter, single-flight, negative-cached, fail-safe. **§3.2 satisfied per service** — each clause-2 test loads a resident model, then moves the control-plane TTL twice (600 → 900 → 1800) and asserts the SAME live cache follows while keeping its resident entry; retention is applied at construction AND to already-alive caches. harness placed in the **Temporal worker** housekeeping tick per §2.4 (a FastAPI-lifespan poll would reconfigure an empty cache); `test_replay_compat.py` untouched and the suite still hermetic. tts's `tts`⇄`tts` namespace trap pinned by test. **R4** fixed additively (required-keys subset, not a re-pinned exact set), taking stt from 2 failures to 1. RED captured first: 24 failing tests. Gates: guardrail 172, harness 908, tts 178, py-runtime-models 74, ruff clean ×3, mypy clean for guardrail/harness, `uv lock --check` clean — each with its `PYTHONPATH` pin (§9.2). **No TypeScript or gateway change** — §2.2 verified as written. Two documented pre-existing failures carried, not fixed: an out-of-manifest stt VAD integration test and 17 tts mypy errors (proven identical before/after by stash). Four deviations in §9.4, chiefly two new bootstrap-transport env vars (D-1) — guardrail and tts had no gateway address at all. **R5 not reproduced in 8 consecutive full runs** (6524 passed each); recorded instead the stale-`dist` import failure the worktree exposed as a plausible confounder. TASK-530 §9.6 errata applied per §4.6, correcting its guardrail claim and closing items 1 and 2. |
| 2026-07-20 | Ticket authored from the TASK-530 execution findings. Code-verified the real per-service matrix, which **corrects TASK-530 §9.6**: guardrail is env-only (no effective-config client at all), so the gap is three services, not two — and guardrail specifically is an unfinished TASK-529 §4.4 promise, i.e. a partial implementation under §2.5 doctrine. Confirmed the server side is already complete for all six services, making this a client-only ticket with no gateway change, no new settings key, and no migration. Records the harness worker-process placement constraint, the tts `tts`⇄`tts` namespace trap, and a forbidden-file list for the concurrent TASK-531 session. Status Pending — awaiting owner approval per rule 01 Phase 3 gate. |
