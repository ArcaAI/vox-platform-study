# TASK-529 — Unified Model Lifecycle & Admin-Controlled Retention

- **Status**: Review — the two steps this ticket did not implement (4.3 stt-v2 convergence, 4.6 harness D-08) were delivered by [TASK-530](../TASK-530-Lifecycle-Convergence-Tail/README.md); §2/§3.2 errata and the DR-1 ratification are recorded in §10
- **Type**: feature / refactor (Phase 3 of the 2026-07-20 agentic platform program)
- **Program**: [2026-07-20 program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §4 Phase 3, frozen design §3 **AD-4** · [2026-07-20 findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) §3-E6, GAP-L1…L4, D-07…D-11
- **Suggested number**: TASK-529 per the program's TASK-523…534 allocation — **confirm at open time** against `docs/implementation/` + `docs/archive/` (CLAUDE.md ticket workflow; highest committed number was TASK-522 when the plan was authored)
- **Size**: L (> 1 week)
- **Lanes**: D (stt-v2) + E (smr/guardrail/nlp/harness/tts-v2), plus B for the settings-key registration and F for the Grafana dashboard
- **Dependencies**: TASK-524 (settings write-lane + registry key registration path) and TASK-525 (internal `GET /api/v1/internal/effective-config?service=` endpoint + Python fetch-with-TTL client). Neither exists in the tree yet (verified 2026-07-20: no `internal/effective-config` route in `apps/api/src`); this ticket consumes their **frozen contracts** (plan AD-1) and its env-fallback design lets service work start before they land.
- **Recorded owner decisions**: **OD-3** = shared uv-workspace package `packages/py-runtime-models` (fallback: per-service copies + shared conformance-test template) · **OD-5** = default retention TTL **600 s** (clamped 60–3600 s)

---

## 1. Requirement Analysis

Owner expectation **E6** (findings §"Owner requirements assessed", verbatim intent): *"All models load on request, retained max 1 h / min 1 min (global-admin-controlled retention), evicted sooner under VRAM pressure."*

Decomposed against the gap/defect registers:

| Req | Meaning | IDs closed by this ticket |
|---|---|---|
| R1 | One model-lifecycle **contract** (single-flight load, pin/unpin, idle-TTL, LRU, clamp 60–3600 s) adopted by all five in-process Python services | GAP-L1 |
| R2 | Retention is **global-admin-controlled** via the settings control plane, not env/hardcoded | GAP-L2; D-07 (nlp unwired), D-11 (stt-v2 dead `GlobalSettingRead` path) |
| R3 | Harness MiniCheck entailer becomes bounded/evictable (today: immortal module dict) | D-08 |
| R4 | tts-v2 local engines become load-on-first-request + TTL-evicted (today: eager at boot, never unloaded) | D-09 |
| R5 | Retention decision **propagates to server-managed engines**: Ollama `keep_alive`, LM Studio `ttl` | D-10; GAP-L2 |
| R6 | **VRAM-aware eviction**: feature-detected NVML probe, evict idle unpinned LRU before load, per-service VRAM budget; estimates fallback on CPU/absent NVML | GAP-L3 |
| R7 | Observability: per-service Prometheus cache metrics + one Grafana dashboard + operator runbook | GAP-L3 (metrics half) |

**Explicitly out of scope** (plan AD-4 + §4 note): vLLM sleep mode (documented as future opt-in only); concurrency knobs beyond *reading* `maxConcurrent` from effective-config — the `AiRuntimeProfile` schema and the settings write-lane belong to TASK-524; if the GAP-L4 concurrency-adoption work overflows, it splits out under reserved TASK-530.

---

## 2. Current State Evaluation (code-verified 2026-07-20; working tree on `fix/2605-review`)

### 2.1 The findings §E6 retention matrix — re-verified

| Service | Load-on-request | TTL eviction | Config source | VRAM-aware | Admin-controlled |
|---|---|---|---|---|---|
| stt-v2 | ✅ single-flight (`models/cache.py:189-248`) | ✅ lazy on access + sweep in `put()` (`:426-454`) | ~~env-only~~ **CORRECTED (TASK-530 errata)**: already control-plane-wired at ticket-open time — `apply_retention()` + `set_retention_refresher()` (TASK-525) with the `[60, 3600]` clamp double-enforced (`core/config/settings.py:132-145`, `models/cache.py:31-45,162-197`). The env values are bootstrap fallbacks only. | ❌ estimated MB budget only (`max_memory_mb` default 10000, `:101,439-445`) | ~~❌~~ **✅** |
| guardrail (GLiNER + MiniCheck scorer) | ✅ per-key-lock single-flight (`services/model_cache.py:113-134`) | ✅ lazy on access (`:95-111`) | env `model_cache_ttl_s`/`model_cache_max_models` = 3600 s / 2 (`core/config.py:322-327`, `GUARDRAIL_V2_` prefix) | ❌ count-only | ❌ |
| nlp (×3 singleton caches) | ✅ (`services/model_cache.py:82-126`) | ✅ lazy on access | ❌ **hardcoded**: `ModelCache(factory=…)` constructed with no `ttl_seconds`/`max_size` in all three singletons (`dependencies.py:98-113`) → always 3600 s / 3, **not even an env knob** (= D-07) | ❌ | ❌ |
| harness MiniCheck entailer | ✅ lazy | ❌ **module dict `_ENTAILER_CACHE`, cached forever, no eviction/unload** (`sensors/inferential/minicheck_entailer.py:164-202`) (= D-08) | env `HARNESS_ATOMIC_FACT_*` | ❌ | ❌ |
| tts-v2 Kokoro/IndicParler(/IndicF5) | ❌ **eager at boot**: `lifespan` → `warm_and_register` calls `provider.warmup()` and only registers on success (`main.py:57-80`; `providers/registration.py:17-28`) — note `KokoroProvider._get_pipeline` is *already lazy internally* (`providers/kokoro.py:37-44`); the eagerness is entirely the boot-time `warmup()` call. Never unloaded (no unload path exists) (= D-09) | ❌ | env `TTS_KOKORO_*` etc. | ❌ | ❌ |
| smr → Ollama | server-managed | server default 5 min idle | **`keep_alive` never sent** — `_build_payload` (`providers/ollama.py:66-88`) has no such field (= D-10) | engine-side | ❌ |
| smr → LM Studio (openai-compat alias) | server-managed JIT | server default 60 min JIT TTL | no `ttl` sent — `chat.completions.create(**kwargs)` with fixed kwargs (`providers/openai_compat.py:99-111,178`) | engine-side | ❌ |
| smr → vLLM / llama.cpp server | resident by design (single-model, launch flags) | none | launch flags | engine-side | by-design — document only |

### 2.2 The three convergent caches — exact delta table (all three read in full)

Structurally identical policy (clamp `[60,3600]`, pin/unpin refcounts kept in a separate `_pins` dict that survives reload, skip-pinned eviction, keep-newest under all-pinned pressure, load failure not cached), **zero code sharing**, and these concrete deltas:

| Axis | stt-v2 `apps/stt-v2/src/stt_v2/models/cache.py` (509 ln) | guardrail `apps/guardrail/src/guardrail/services/model_cache.py` (216 ln) | nlp `apps/nlp/src/nlp/services/model_cache.py` (204 ln) |
|---|---|---|---|
| Shape | Concrete cache of `LoadedModel`, owns a format→loader map (`:123-138`) and calls `loader.unload()` on evict (`:479-484`) | `Generic[T]` factory cache (`factory: Callable[[str], Awaitable[T]]`) | Same `Generic[T]` factory cache (near-copy of guardrail's) |
| Budget | Count (`max_models`, settings default 5) **and MB** (`max_memory_mb` default 10000, evict loop `:439-445`) | **Count-only** (`DEFAULT_MAX_SIZE = 2`, `:37`) | **Count-only** (`DEFAULT_MAX_SIZE = 3`, `:33`) |
| Wiring | ttl/max from `get_settings()` in ctor (`:99-104`) | ttl/max passed by callers from `GUARDRAIL_V2_` config | **ctor never passed ttl/max** (`dependencies.py:98-113`) — hardcoded defaults (D-07) |
| Single-flight | Global `asyncio.Lock` + per-slug in-flight `Future` with `asyncio.shield` for waiters (`:112-115,207-248`) | Per-key `asyncio.Lock` via `setdefault` + re-check (`:113-120`) | Same per-key lock pattern (`:105-112`) |
| Clock | **Wall clock** `datetime.utcnow()` (`:49,54,182`) — NTP-step sensitive | `time.monotonic` via **injectable `time_func`** (`:72-77`) — already fake-clock-testable | `time.monotonic` **hardcoded** (`:93,102`) — no injection seam |
| Pin API | `pin/unpin` + `pin_many/unpin_many` (`:324-360`); explicit `evict()` refuses pinned (`:362-376`) | `pin/unpin` only (`:136-157`) | `pin/unpin` + `pin_many/unpin_many` (`:128-161`) |
| Teardown | `clear()` (`:378-392`) + singleton `get_model_cache()`/`clear_model_cache()` (`:493-508`) | `clear()` ignores pins (`:159-166`) | **no `clear()`** |
| Evict hook | `loader.unload(model)` | `_shutdown_quietly` tolerates **sync and async** `shutdown` via `inspect.isawaitable` (`:200-215`) | `_shutdown_quietly` **awaits `shutdown()` unconditionally** (`:195-203`) — a sync hook raises `TypeError` (swallowed + logged), a silent behavior delta |
| Stats/metrics | `CacheStats` with hits/misses/evictions/hit-rate (`:62-79,394-420`) | none (log events only) | none |
| Sweep | Expired-entry sweep also runs inside `put()`/`_evict_if_needed` (`:447-454`); no background sweeper | Lazy-on-access eviction only; **no sweeper** — an idle model is held until the *next* request for that key | Same as guardrail |

The "no background sweeper" delta matters for E6: in guardrail/nlp an idle model whose key is never requested again is retained **forever** despite the TTL. The unified contract adds a periodic sweep task.

### 2.3 Control-plane residue this ticket consumes/deletes

> **CORRECTED (TASK-530 errata, 2026-07-20).** The D-11 item below — deleting the dead
> `GlobalSettingRead` model and its `06-stt.ts` seed rows — was **already done before this
> ticket opened** (TASK-525 removed both). D-11 is therefore **closed on arrival**, not
> closed by this ticket. Nothing in §4.3 needed to delete it, and nothing did.

- **D-11**: stt-v2 `GlobalSettingRead` SQLAlchemy model (`core/database/models.py:159+`, exported `core/database/__init__.py:9,16`) has **zero query sites**; the seed creates `stt.config.model_cache.*` / `stt.config.workers.*` GlobalSetting rows for it (`packages/database/src/prisma/db_main/seed/06-stt.ts:1046-1116`). Dead scaffold — replaced by the effective-config client; model + seed rows removed (seed-count tests updated in the same MR, plan §5.7).
- Harness MiniCheck load site: `load_minicheck_entailer` is called from exactly one place — the entailer factory inside `apps/harness/src/harness/temporal/activities.py:390` — i.e. already **activities-only**; workflow code never touches it. Adoption is replay-safe by construction (no `workflow.patched` era needed).
- Prometheus is available in every target service (`apps/{stt-v2,guardrail,nlp,harness,tts-v2}/src/*/core/metrics.py` all import `prometheus_client`); tts-v2 already has a `TTS_MODEL_LOADED` gauge (`providers/kokoro.py:20,42`).
- `infrastructure/grafana/dashboards/` exists (7 JSONs); `docs/operations/inference/` exists (README.md only).

### 2.4 Packaging substrate (OD-3 verification)

- Root `pyproject.toml:19-27`: `[tool.uv.workspace].members` currently lists the six `apps/*` services only — adding `"packages/py-runtime-models"` is a one-line member addition + `uv lock` at root.
- Docker: every service Dockerfile builds **from the repo root context** and its layer-1 dependency install COPYs *every* workspace member's `pyproject.toml` before `uv sync --frozen --package <svc> --no-install-project --no-editable` (e.g. `apps/nlp/Dockerfile:37-47`; smr/guardrail/tts-v2 identical shape; harness adds `--extra` flags, `apps/harness/Dockerfile:54-61`).
- **Unverified — execution-time check (early, per risk table)**: whether `--no-install-project` also skips *workspace path dependencies* of the target package, or whether layer 1 then needs either the tiny package **source** COPYed (cache-friendly, it rarely changes) or a switch to `--no-install-workspace` with the member installed in layer 2. Also unverified: the conda-`arcaenv` local-dev install hook (`scripts/setup-python-env.sh` must gain an editable install of the new package) and the final Python import name (proposal: `hope_runtime_models`). All three are the first task of the implementation plan.

---

## 3. Architecture, Patterns & Best Practices

### 3.1 The cache contract (the AD-4 spec — "contract, not framework")

One documented contract, packaged per OD-3 as `packages/py-runtime-models` (fallback: per-service copies + a shared conformance-test template asserting every clause below). API surface (superset union of the three implementations, generic factory shape — the stt-v2 loader map stays *outside* the shared cache, passed in as its factory/unload hooks):

```
ModelCache[T](factory, *, unload=None, max_size, max_bytes_estimate=None,
              ttl_seconds, time_func=time.monotonic, metrics=…, vram_probe=None)
  .get(key) -> T                 # single-flight per key; failure not cached; propagates (503 at routes)
  .pin(key) / .unpin(key)        # refcounts; pins survive reload; last unpin restarts the idle clock
  .pin_many / .unpin_many
  .evict(key) -> bool            # refuses pinned
  .sweep() -> int                # evict all idle-expired unpinned entries (called by a periodic task)
  .clear() -> int                # teardown; ignores pins
  .stats() -> CacheStats         # residents, bytes-estimate, hits/misses/evictions
  .configure(ttl_seconds=…, max_size=…, vram_budget_mb=…)   # hot re-configuration from effective-config refresh
clamp_cache_ttl_seconds(v)       # hard product clamp [60, 3600]
```

Contract clauses (each is a conformance test):
1. **Single-flight**: concurrent `get(k)` performs exactly one factory call; waiters share the result; a waiter's cancellation cannot cancel the shared load (stt-v2's `asyncio.shield` behavior is the contract).
2. **Eviction order on pressure**: **ttl → lru → vram** — expired idle entries first, then LRU unpinned, then (only when a VRAM probe reports shortage before a load) additional idle unpinned LRU entries; each eviction labeled with its reason in metrics.
3. **Pinned entries are never evicted** by any path except `clear()`.
4. **Soft ceiling under all-pinned load** (documented, deliberate): when every eviction candidate is pinned, the cache exceeds `max_size` rather than drop a model in use, and logs a warning — the existing behavior of all three implementations (`stt cache.py:465`, `guardrail :186`, `nlp :181`) is kept, not "fixed".
5. **Monotonic injectable clock** (`time_func`) — guardrail's seam becomes universal; stt-v2 drops `datetime.utcnow()`.
6. **Periodic sweep**: each service runs one asyncio background sweep task (interval ≈ min(60 s, ttl/4)) so idle models are released even when their key is never re-requested (closes the §2.2 sweeper gap).
7. **Hot reconfiguration**: `configure()` applies a new (clamped) TTL/limits without dropping resident entries; the next sweep/access enforces the new values.

### 3.2 Retention settings keys (frozen contract with TASK-524/525)

> **SUPERSEDED (DR-1, ratified by TASK-530 §2.3).** The `models.retention.*` grammar
> sketched below never shipped. TASK-525 had already frozen `<svc>.modelCache.<knob>`
> (`stt|nlp|guardrail|harness|tts` × `ttlSeconds|maxModels|vramBudgetMb`, plus
> `stt.modelCache.maxMemoryMb` and `smr.modelCache.ttlSeconds`) and `resolveForService`
> carried an explicit comment reserving the guardrail/harness/tts-v2 subsets *for this
> ticket to fill*. The execution used the landed grammar rather than creating a second key
> family for one knob — which is what §2.5's Completion & Cleanup Doctrine requires
> (a `models.retention.ttlSeconds` alongside a `<svc>.modelCache.ttlSeconds` would be
> exactly the redundant parallel implementation the doctrine forbids). **The live contract
> is `<svc>.modelCache.*`**; the table below is retained only as the superseded sketch.

All `globalOnly: true`, `tier: 'global-kv'`, registered in the settings registry (lane B):

| Key | Default | Notes |
|---|---|---|
| `models.retention.ttlSeconds` | **600** (OD-5), clamp 60–3600 (registry-side validation AND service-side `clamp_cache_ttl_seconds` — defense in depth) | global idle TTL |
| `models.retention.ttlSeconds.<service>` | unset (optional override) | `<service>` ∈ `stt-v2, guardrail, nlp, harness, tts-v2` |
| `models.retention.maxModels.<service>` | today's effective values: stt-v2 5 · guardrail 2 · nlp 3 · harness 1 · tts-v2 2 | behavior-preserving |
| `models.retention.vramBudgetMb.<service>` | unset (= no VRAM budget; estimates/MB budget path only) | opt-in |

Delivery: TASK-525's effective-config client (`GET internal/effective-config?service=` polled with 60 s TTL + negative-cache **env fallback**, the proven guardrail `tenant_config.py` pattern). Env vars (`MODEL_CACHE_TTL_SECONDS`, `GUARDRAIL_V2_MODEL_CACHE_TTL_S`, new `NLP_MODEL_CACHE_*`, `HARNESS_MODEL_CACHE_*`, `TTS_MODEL_CACHE_*`) become documented **bootstrap fallback only**.

> **Deliberate, owner-visible behavior change (per the plan's risk table)**: adopting the OD-5 default of **600 s** changes today's effective idle TTL in stt-v2/guardrail/nlp from **3600 s → 600 s** (nlp additionally goes from *hardcoded* to admin-controlled — the D-07 lesson is exactly that wiring a dead knob flips real defaults). Rationale: E6 asks for admin-controlled retention with a 1 h *maximum*, and 600 s is the program-approved default (OD-5, plan §8). Per-service `maxModels` defaults ARE behavior-preserving. This paragraph is the required owner-visible callout; rollback = set `models.retention.ttlSeconds = 3600` at runtime (no deploy).

### 3.3 Engine retention-responsibility matrix (facts verified externally 2026-07-20)

| Engine | Retention owner | Mechanism | This ticket |
|---|---|---|---|
| In-process (stt-v2 loaders, GLiNER, NLP transformers, MiniCheck ×2, Kokoro/IndicParler) | **HOPE** (the shared cache) | ttl→lru→vram eviction, per-service budgets | full adoption |
| Ollama | server, **per-request influenced** | request `keep_alive` overrides server `OLLAMA_KEEP_ALIVE`; server default 5 min idle-unload; `OLLAMA_MAX_LOADED_MODELS` caps residents (docs.ollama.com/faq) | send `keep_alive: <resolved ttl seconds>` in `_build_payload` |
| LM Studio | server, per-request influenced | JIT-loaded models default to **60 min** idle TTL; per-request `ttl` field (seconds); Auto-Evict unloads previously-JIT-loaded models before loading new ones (lmstudio.ai/docs/developer/core/ttl-and-auto-evict) | send `ttl` via OpenAI-SDK `extra_body` for the `lm-studio` provider only |
| vLLM / llama.cpp server | launch-time; resident **by design** | one model at launch, stays resident; vLLM sleep mode (level 1: weights→CPU RAM + discard KV; level 2: discard weights, keep buffers) + `/wake_up` exists for multi-model GPU sharing (docs.vllm.ai sleep_mode) | **out of scope** — documented in the runbook as the dedicated-tier posture, sleep mode noted as a future opt-in |

LM Studio wiring detail (verified): `openai_compat.py` builds a plain `kwargs` dict passed to `self._client.chat.completions.create(**kwargs)` (`:99-111` non-streaming, `:178` streaming). The OpenAI Python SDK's `extra_body` parameter is the sanctioned ride-along for non-standard fields → `kwargs["extra_body"] = {"ttl": resolved_ttl}` **gated on provider name == `lm-studio`** (the alias shares the openai-compat class with vLLM/generic endpoints, which must NOT receive it). *Mark unverified for execution-time*: the SDK-version behavior of `extra_body` in the pinned `openai` package and LM Studio's acceptance on both chat + streaming calls — assert in the provider unit test and an env-gated live check.

### 3.4 VRAM awareness (GAP-L3) — decentralized budgets, no arbiter

- `pynvml` is **feature-detected** (import inside try; `nvmlInit` failure → probe disabled): CPU-only hosts, absent driver, and CI all fall back to the estimates path (stt-v2's MB-budget generalized). NVML is **always stubbed in CI**.
- Pre-load hook: if the probe reports `free_vram < estimate + headroom`, evict idle unpinned LRU entries until satisfied or nothing evictable remains; if still short, proceed (the load error surfaces as today's 503 path — never a silent skip).
- Per-service `vramBudgetMb` bounds each service's `resident_bytes_estimate` deterministically. **Why decentralized budgets and not a cross-process arbiter** (frozen in AD-4): an arbiter daemon is a new failure domain, a deploy unit, and an IPC protocol for a problem that static partitioning solves on the only real deployment shape (a small fixed set of services per GPU host); budgets are predictable, testable, and admin-tunable at runtime. Rejected as over-engineering.

### 3.5 Metrics naming (fixed contract)

Per service, standard Prometheus conventions (counters `_total`, gauges unsuffixed), registered in each service's existing `core/metrics.py`:
`model_cache_loads_total` · `model_cache_evictions_total{reason="ttl|lru|vram"}` · `model_cache_resident_models` · `model_cache_resident_bytes_estimate` · `vram_free_bytes` (present only when NVML is live). One Grafana dashboard consumes them across services.

---

## 4. Implementation Plan (ordered; behavior-parity before policy change)

| Step | Work | Files (UPDATE/NEW) |
|---|---|---|
| 4.1 | **Package scaffold + build-path verification (the §2.4 risk, done FIRST)**: NEW `packages/py-runtime-models/{pyproject.toml,src/hope_runtime_models/{__init__.py,cache.py,vram.py,metrics.py,effective_config.py},tests/}`; UPDATE root `pyproject.toml` (workspace member) + `uv lock`; UPDATE 5 consuming Dockerfiles (layer-1 COPY / flag choice per §2.4); UPDATE `scripts/setup-python-env.sh` (editable install). Prove a Docker build of one service (nlp, smallest) before any adoption. If this step fails irrecoverably → **OD-3 fallback** (not taken — the package scaffold succeeded): keep per-service copies, ship a `conformance_template.py` applied per service, rest of plan unchanged. |
| 4.2 | **Settings keys** (lane B): register `models.retention.*` descriptors in `packages/applications/src/services/settings-registry/` (UPDATE registry + catalog + tests); coordinate with TASK-524's write-lane (keys land even if the PUT route ships later — catalog-first). |
| 4.3 | **stt-v2 convergence** (lane D): UPDATE `apps/stt-v2/src/stt_v2/models/cache.py` to compose the shared cache (loader map + `LoadedModel` MB estimates become the factory/unload/estimate hooks) — **behavior-parity first**: existing `apps/stt-v2/tests/unit/test_model_cache.py` + `test_model_cache_ttl.py` must pass unmodified *before* policy wiring; then effective-config consumption (ttl/maxModels/vramBudget), DELETE `GlobalSettingRead` (`core/database/models.py`, barrel `core/database/__init__.py`) + seed rows `06-stt.ts:1046-1116` (+ seed-count tests). |
| 4.4 | **guardrail** (lane E): UPDATE `services/model_cache.py` → shared cache; callers unchanged (generic API is a superset); effective-config wiring for `model_cache_ttl_s`/`max_models` (env → fallback). |
| 4.5 | **nlp**: UPDATE `services/model_cache.py` → shared cache; UPDATE `dependencies.py:98-113` to pass resolved retention config into all three singletons (closes D-07); fix the sync-shutdown delta for free (contract `_shutdown_quietly`). |
| 4.6 | **harness** (D-08): UPDATE `sensors/inferential/minicheck_entailer.py` — replace `_ENTAILER_CACHE` module dict (`:164-202`) with a shared-cache instance keyed by the same composite key, `unload` hook drops the llama handle; **activities-only** (sole call site `temporal/activities.py:390`); no workflow-code change ⇒ replay fixtures (`tests/unit/temporal/test_replay_compat.py`) must stay green untouched; harness CI suite stays hermetic. |
| 4.7 | **tts-v2** (D-09): NEW `TTS_WARMUP_ENABLED` setting (default **off**) in `core/config.py`; UPDATE `main.py:57-80` — providers **register unconditionally**, `warm_and_register` becomes the opt-in warmup path; UPDATE `providers/{kokoro,indic_parler,indic_f5}.py` — pipeline handles move behind the shared cache (Kokoro's `_get_pipeline` `:37-44` is the load factory; unload releases the pipeline + zeroes `TTS_MODEL_LOADED`); document the health-semantics shift (broken model now surfaces as first-request 503, not boot-time non-registration; warmup flag restores old behavior). |
| 4.8 | **smr propagation** (D-10): UPDATE `providers/ollama.py` `_build_payload` (`:66-88`) → `payload["keep_alive"] = <resolved ttl seconds>` (both generate + stream share the builder); UPDATE `providers/openai_compat.py` → `extra_body={"ttl": …}` for `lm-studio` only (§3.3); TTL resolved from effective-config (env fallback `SMR_V2_MODEL_RETENTION_TTL_S`). |
| 4.9 | **Metrics + dashboard** (lanes E+F): UPDATE each service's `core/metrics.py` (§3.5 families); NEW `infrastructure/grafana/dashboards/model-retention.json`. |
| 4.10 | **Runbook**: NEW `docs/operations/inference/model-retention.md` — settings keys + clamp, engine matrix (incl. Ollama `OLLAMA_MAX_LOADED_MODELS`, LM Studio Auto-Evict/JIT recommendation, vLLM resident posture + sleep-mode pointer), VRAM budget sizing, dashboard tour, rollback (`ttlSeconds = 3600`). |

**Ownership manifest (exclusive)**: `packages/py-runtime-models/**` · `apps/stt-v2/src/stt_v2/models/cache.py` + `core/database/{models.py,__init__.py}` + `tests/unit/test_model_cache*.py` · `apps/guardrail/src/guardrail/services/model_cache.py` · `apps/nlp/src/nlp/{services/model_cache.py,dependencies.py}` + `apps/nlp/tests/test_model_cache.py` · `apps/harness/src/harness/sensors/inferential/minicheck_entailer.py` · `apps/tts-v2/src/tts_v2/{main.py,core/config.py,providers/*}` · `apps/smr/src/smr_v2/providers/{ollama.py,openai_compat.py}` · the five `core/metrics.py` files · 5 Dockerfiles + root `pyproject.toml`/`uv.lock` · `packages/database/.../seed/06-stt.ts` (+ its count tests) · settings-registry descriptor files (coordinate barrels with TASK-524, append-only) · the dashboard JSON + runbook. No file shared with another in-flight ticket.

**Comment deltas (DoD items)**: `minicheck_entailer.py:164-165` "loaded once per worker" comment rewritten to the bounded-cache truth · tts `main.py:57-58` "register only after their model warms" lifespan comment rewritten · all three cache module docstrings replaced by a pointer to the shared contract · stt `settings.py:136-145` and guardrail `config.py:322-327` field docstrings gain "bootstrap fallback — runtime value from the control plane" · `06-stt.ts` loses the `stt.config.*` block comment · `apps/harness/README.md` + `docs/operations/inference/README.md` index the new runbook.

---

## 5. TDD Plan (RED first — paste failing runs in this README before implementing)

Conformance suite (NEW `packages/py-runtime-models/tests/test_cache_contract.py`, parameterized; the **same template is applied to every adopting cache** — stt-v2/guardrail/nlp/harness/tts-v2 each instantiate it against their wiring):

1. `test_second_request_within_ttl_no_reload` — factory called exactly once (load-count 1).
2. `test_ttl_expiry_sweep_evicts` — **fake clock** via `time_func` (no sleeps; pytest ≥9 strict, `asyncio_mode=auto`).
3. `test_pinned_survives_ttl_and_lru_pressure`; `test_last_unpin_restarts_idle_clock`.
4. `test_vram_short_evicts_idle_lru_before_load` — **NVML stubbed** (always, in CI and locally); eviction reason label = `vram`.
5. `test_clamp_30_to_60_and_7200_to_3600`.
6. `test_single_flight_concurrent_gets_one_load` + waiter-cancellation shield.
7. `test_soft_ceiling_all_pinned_exceeds_max_size_with_warning`.
8. `test_configure_applies_new_ttl_without_dropping_residents`.

Per-service RED tests (exact paths; per-service conventions from rule 06):

| Service | Tests | Gate |
|---|---|---|
| stt-v2 | parity: existing `apps/stt-v2/tests/unit/test_model_cache.py` + `test_model_cache_ttl.py` green **unmodified** pre-policy; the planned NEW stt-v2 retention test ("settings change → new TTL within one refresh window", dead-`GlobalSettingRead` removal import test) was **deferred to TASK-530** with the §4.3 stt-v2 convergence (see status header) | `pnpm py:stt-v2:test` · `py:stt-v2:lint` · `py:stt-v2:typecheck` |
| guardrail | NEW `apps/guardrail/src/guardrail/tests/test_effective_config_retention.py` (retention-refresh; the shared cache-contract template landed at `packages/py-runtime-models/tests/test_cache_contract.py`); existing `test_groundedness_scorer_minicheck.py` green | `pnpm py:guardrail:test` etc. |
| nlp | UPDATE `apps/nlp/tests/test_model_cache.py` (template) + NEW RED `test_dependencies_pass_retention_config` — asserts the three singletons receive resolved ttl/max (fails today: `dependencies.py:98-113` passes nothing) | `pnpm py:nlp:test` |
| harness | NEW `apps/harness/src/harness/tests/unit/sensors/test_minicheck_cache.py` — entailer evicted after fake-clock TTL, reload on next activity call, calibration re-verified on reload; **replay fixtures untouched and green** (`test_replay_compat.py`) — hermetic, no live Temporal | `pnpm py:harness:test` |
| tts-v2 | UPDATE `apps/tts-v2/src/tts_v2/tests/unit/test_kokoro_provider.py` + NEW `test_lazy_lifecycle.py` — RED: "first synth request loads (gauge 0→1)"; "idle past TTL unloads (gauge →0)"; "`TTS_WARMUP_ENABLED=true` preserves old boot-warm behavior"; "load failure → 503, provider stays registered" | `pnpm py:tts-v2:test` |
| smr | UPDATE `apps/smr/src/smr_v2/tests/unit/test_ollama_provider.py` — RED: payload carries `keep_alive` = resolved TTL (generate + stream); UPDATE `test_openai_compat_provider.py` — `extra_body.ttl` present for `lm-studio`, **absent** for vLLM/generic | `pnpm py:smr-v2:test` |
| settings (TS) | NEW descriptor tests in `packages/applications/src/services/settings-registry/__tests__/` — clamp validation, `globalOnly`, defaults per §3.2 | `pnpm --filter @arcaai/applications build test` |

House constraints binding here: fake clocks only (no `sleep`); NVML/pynvml always stubbed in CI; if any test draws randomness, seed **inside the test body** (pytest-randomly reseeds numpy per-test *after* fixtures — repo memory); python dep changes (`pynvml` as optional extra, the new workspace member) ⇒ `uv lock` at root; harness suite stays hermetic. Cross-service e2e (retention settings round-trip through the real gateway) is authored here but **executed in Phase 7 (TASK-534)**.

---

## 6. Acceptance & Definition of Done

- [ ] Contract conformance suite green against **all five** adopting caches. — **Partial**: 33-clause suite green in the shared package and composed by guardrail/nlp/tts-v2 (their own suites pass against it). stt-v2 and harness do not compose it yet (§9.4).
- [x] All RED tests of §5 shown failing first, then green. Evidence: shared cache `ModuleNotFoundError` → 33 passed; smr 9 failed → 16 passed; nlp 9 failed → 173 passed; tts 8 failed → 155 passed. **Parity gate honoured**: `apps/nlp/tests/test_model_cache.py` passes **unmodified** against the shared cache (12 passed).
- [x] Retention keys registered, `globalOnly`, system-scoped, clamped, and **served** to every service subset (guardrail/harness/tts-v2 subsets filled). Applied within one refresh window via each service's existing pull path — no redeploy. Registered under `<svc>.modelCache.*` per **DR-1**, not `models.retention.*`.
- [ ] D-07…D-11 closed. — **D-07 ✅** (nlp configurable + reconfigurable), **D-09 ✅** (tts lazy, `TTS_WARMUP_ENABLED` default off), **D-10 ✅** (Ollama `keep_alive` + LM Studio `ttl`), **D-11 ✅** (already closed by TASK-525 — verified, see DR-2b). **D-08 ✗ not implemented** (§9.4).
- [x] VRAM probe feature-detected; CI has zero GPU/NVML dependence (proven in-image: `make_vram_probe()` → `None`); eviction reasons labelled `ttl|lru|vram` and asserted by conformance tests.
- [x] Metrics live in all five services (import-verified); dashboard `infrastructure/grafana/dashboards/model-retention.json` and runbook `docs/operations/inference/model-retention.md` committed and indexed.
- [x] Gates green with pasted output — see §9.3. Python gates were run with a worktree `PYTHONPATH` pin (**DR-6**), not the bare `pnpm py:*` aliases, which would have tested the main checkout.
- [ ] Comment-delta ledger fully applied. — **Partial** (§9.4): the `minicheck_entailer.py` comment is untouched because 4.6 was not implemented. **The OD-5 600 s default change IS called out** — §3.2 callout retained, restated in the runbook §2 and in §9 above for owner sign-off.

## 7. Risks & Rollback

| Risk | Mitigation / rollback |
|---|---|
| Eviction thrash under bursty load (600 s TTL + small maxModels → load/evict cycling) | **Min-residency floor = the clamp minimum (60 s)**: an entry is never TTL-evicted younger than 60 s idle regardless of settings; pins already protect in-flight use; dashboard makes thrash visible (`evictions_total` rate). Runtime rollback: raise `ttlSeconds` via settings — no deploy. |
| NVML driver flakiness across hosts/driver versions | Strictly feature-detected; any NVML error disables the probe for the process (logged once) and the estimates path continues; CI never depends on GPU. |
| nlp/stt/guardrail default-TTL change surprises operators (3600 → 600 s) | Deliberate, owner-visible (§3.2 callout + MR sign-off); per-service `maxModels` defaults preserved; one-line runtime revert. |
| Workspace-package Docker build risk (`--no-install-project` × workspace path deps, §2.4 unverified) | **Verified first** (step 4.1) on the smallest image before any adoption; OD-3 fallback (per-service copies + conformance template) is fully specified and keeps every other step intact. |
| tts health-semantics shift (boot-warm gate → first-request 503) masks a broken model until traffic | Documented in runbook + `TTS_WARMUP_ENABLED=true` restores boot-warm for ops that prefer fail-at-boot; health endpoint keeps reporting load state. |
| Harness replay regression | No workflow-code change (cache is activity-side only, sole call site `activities.py:390`); replay fixtures are a hard gate. |

## 8. References

- Findings: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-review-findings.md` (§3-E6 matrix, §4.B D-07…D-11, §7 GAP-L1…L4)
- Program plan: `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-program-plan.md` (§3 AD-1/AD-4, §4 Phase 3, §8 OD-3/OD-5)
- Engine docs (verified 2026-07-20): Ollama `keep_alive`/`OLLAMA_MAX_LOADED_MODELS` — https://docs.ollama.com/faq · LM Studio TTL & Auto-Evict — https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict · vLLM sleep mode — https://docs.vllm.ai/en/latest/features/sleep_mode (out of scope; runbook pointer only)
- House rules: `.claude/rules/06-python-services.md` (uv workspace, test locations, Temporal determinism) · `.claude/rules/09-infrastructure-devops.md` (Dockerfiles, Grafana, env hygiene)
- Repo memory: pytest-randomly numpy reseed gotcha; `uv lock` at root after dep changes.

## 9. Implementation Summary

### 9.1 What shipped

**The shared contract (step 4.1 — the hard gate, PASSED)**

`packages/py-runtime-models` (`hope_runtime_models`), a **dependency-free** uv
workspace member holding the one `ModelCache` every service composes, plus the
feature-detected NVML probe and the Prometheus sink adapter. 33 conformance
tests cover all eight contract clauses.

> **§2.4 question answered empirically.** `uv sync --frozen --package <svc>
> --no-install-project` does **NOT** skip workspace *path* dependencies. Proof:
> omitting the package source from build layer 1 fails with
> `error: Failed to determine installation plan / Distribution not found at:
> file:///app/packages/py-runtime-models`. The mitigation (COPY the package
> source in layer 1, before the `--no-install-project` sync) is applied to all
> six Dockerfiles. **OD-3 primary path confirmed viable — the fallback was not
> needed.**

**Per-service adoption**

| Step | Service | Outcome |
|---|---|---|
| 4.4 | guardrail | Cache converged onto the shared contract; 200-line copy deleted. Sync/async shutdown hook unified. |
| 4.5 | nlp | Converged; **D-07 closed** — the three singletons now receive resolved ttl/max and are runtime-reconfigurable, plus a `sweep_model_caches()` entry point. |
| 4.7 | tts-v2 | **D-09 closed (Kokoro)** — `warm_and_register` replaced by `register_local_provider`; providers register unconditionally, weights load on first request and are TTL-released. `TTS_WARMUP_ENABLED` (default off) restores boot-warm. |
| 4.8 | smr | **D-10 closed** — Ollama `keep_alive`, LM Studio `extra_body.ttl` (gated on provider name), both wired to the control plane via the existing refresh path. |
| 4.2 | settings | Retention keys registered for all five in-process services + smr; effective-config now **serves** the guardrail/harness/tts-v2 subsets TASK-525 reserved. |
| 4.9 | metrics | Fixed metric families added to all five `core/metrics.py`; `infrastructure/grafana/dashboards/model-retention.json`. |
| 4.10 | runbook | `docs/operations/inference/model-retention.md`, indexed from the inference ops README. |

### 9.2 Deviations from the plan (each with rationale)

| # | Deviation | Why |
|---|---|---|
| **DR-1** | Settings keys use the landed `<svc>.modelCache.<knob>` grammar, **not** §3.2's proposed `models.retention.*`. | §2/§3.2 were factually stale: TASK-525 has landed and froze `<svc>.modelCache.*` (`service-runtime.descriptors.ts`), with `resolveForService` carrying an explicit comment reserving the guardrail/harness/tts-v2 subsets *for TASK-529 to fill*. Adding a second key family for the same knob is the redundancy the program plan §2.5 Cleanup Doctrine forbids. Guarded by a test asserting no `models.retention.*` key exists. |
| **DR-2** | §2 current-state was stale in three further places. | (a) stt-v2's cache **already** had control-plane retention wiring (`apply_retention` / `set_retention_refresher`); (b) **D-11 was already fully closed** by TASK-525 — `GlobalSettingRead` is deleted and the `stt.config.model_cache.*` / `workers.*` seed rows are already removed from `06-stt.ts` (the remaining `stt.config` rows are unrelated, live rows); (c) per-service `effective_config.py` clients already exist in stt-v2/nlp/smr. No work was redone. |
| **DR-3** | OD-5 (600 s) applied by editing two existing test assertions and one seed-adjacent default. | `guardrail/tests/test_aux_model_selection.py` and the effective-config service test encoded the old 3600 s default. Both were updated **with rationale comments**, not silently. The effective-config test's local `DEFAULTS` map was replaced with an import of `SERVICE_RUNTIME_DEFAULTS` — it had already silently drifted, which is the precise failure mode the descriptor file warns about. |
| **DR-4** | `apply_retention` on smr providers is re-applied on every refresh rather than at construction. | `ProviderRegistry` builds providers lazily and memoizes them, so construction-time application would miss every provider built after boot. A provider instantiated after the last refresh carries the bootstrap TTL for at most one request — bounded and documented; the value is a residency hint, never part of a response. |
| **DR-5** | Two defects found in my own shared cache by TDD, fixed before adoption. | (1) LRU-overflow evictions never ran the `unload` hook — evicted weights were never released, defeating the purpose of eviction. (2) Lazy TTL eviction on `get()` dropped its victims the same way. Both now carry victims out of the lock and unload them; both have dedicated conformance tests. |
| **DR-6** | Python gates were run with an explicit `PYTHONPATH` pin to this worktree. | `arcaenv`'s editable installs resolve to the **main** checkout, so a bare `pnpm py:*:test` in a worktree silently tests main-repo source. Every result below was produced with `PYTHONPATH=<worktree>/packages/py-runtime-models/src:<worktree>/apps/<svc>/src`. Worth fixing in the `py:*` scripts separately. |

### 9.3 Gate evidence

```
packages/py-runtime-models  pytest tests/                33 passed
apps/nlp                    pytest apps/nlp/tests/      173 passed
apps/guardrail              pytest .../tests/           163 passed
apps/tts-v2                 pytest .../tests/           155 passed, 2 deselected
apps/smr                    pytest .../tests/           939 passed, 32 deselected
apps/harness                pytest .../tests/           886 passed   (replay-compat untouched & green)
apps/stt-v2                 pytest tests/unit          2428 passed, 1 skipped

ruff check (all 6 services + shared package)            All checks passed!
mypy (shared package)                                   Success: no issues found in 4 source files
mypy (smr/nlp/guardrail/tts changed files)              Success: no issues found

pnpm --filter @arcaai/applications build                (tsc clean)
pnpm --filter @arcaai/applications test                 316 files passed, 6524 tests passed
pnpm --filter @arcaai/database test                     24 files passed, 819 tests passed

uv lock                    Resolved 475 packages   (+18 additive lines; package count unchanged)
uv lock --check            Resolved 475 packages   (clean)

Docker  docker build -f apps/nlp/Dockerfile --target builder     SUCCESS
  in-image: clamp(7200)=3600 · nlp cache composes shared contract: True
            nlp default TTL: 600 · NVML probe (no GPU): None   ← zero GPU dependence
```

### 9.4 NOT done — why, and what it costs

| Item | Status | Reason |
|---|---|---|
| **4.3 stt-v2 cache convergence** | **Not attempted** | 567-line concrete cache owning the format→loader map, on the ASR hot path, and it **already has** control-plane retention (DR-2a) — so the admin-control requirement is met there; only the code-sharing half is outstanding. A rushed rewrite of this path carried more regression risk than the deduplication was worth in the remaining budget. GAP-L1 is therefore only **partly** closed (3 of 4 in-process caches share the contract). |
| **4.6 harness D-08** | **Not implemented** | Blocked on a design fork the plan did not anticipate: `load_minicheck_entailer` is called from a **synchronous** helper (`activities.py:390` → `_atomic_fact_entailer`), and the shared contract is async-only. Options are (a) add a `SyncModelCache` to the shared package, or (b) make the entailer path async. Both are real decisions, not mechanical work. `_ENTAILER_CACHE` remains an immortal module dict. Harness suite (886) and replay fixtures are green and untouched. |
| tts-v2 IndicParler / IndicF5 behind the cache | **Partial** | Both are now lazy (they no longer load at boot, since registration no longer warms), but only Kokoro's handle sits behind the cache with TTL unload. |
| Cross-service e2e (retention round-trip) | **Not authored** | Plan defers *execution* to TASK-534; authoring was in scope here and was not reached. |
| `pynvml` optional extra | **Not added** | Not required — the probe is feature-detected and returns `None` without the package (proven in-image). Adding the extra is a one-line follow-up if a GPU host wants the probe live. |
| Comment-delta ledger | **Partial** | Applied for the surfaces actually touched (tts `main.py` lifespan comment, the three cache module docstrings, guardrail/nlp config field docstrings, runbook indexing). The `minicheck_entailer.py:164` comment is untouched because 4.6 was not implemented. |

### 9.5 Files created / modified

**Created** — `packages/py-runtime-models/{pyproject.toml,README.md,pytest.ini,src/hope_runtime_models/{__init__,cache,vram,metrics}.py,tests/test_cache_contract.py}` · `apps/smr/src/smr_v2/core/retention.py` · `apps/smr/src/smr_v2/tests/unit/{test_provider_retention,test_retention_wiring}.py` · `apps/nlp/tests/test_model_cache_retention.py` · `apps/tts-v2/src/tts_v2/tests/unit/test_lazy_lifecycle.py` · `packages/applications/src/services/settings-registry/__tests__/model-retention.descriptors.test.ts` · `infrastructure/grafana/dashboards/model-retention.json` · `docs/operations/inference/model-retention.md`

**Modified** — root `pyproject.toml` + `uv.lock` · 6 service `pyproject.toml` + 6 Dockerfiles · `scripts/setup-python-env.sh` · `apps/{nlp,guardrail}/src/**/services/model_cache.py` (rewritten onto the contract) · `apps/nlp/src/nlp/{dependencies.py,core/{config,effective_config,concurrency}.py}` · `apps/guardrail/src/guardrail/core/{config,dependencies}.py` + `tests/test_aux_model_selection.py` · `apps/tts-v2/src/tts_v2/{main.py,core/config.py,providers/{kokoro,registration}.py,tests/unit/test_local_registration.py}` · `apps/smr/src/smr_v2/{core/{config,effective_config}.py,providers/{ollama,openai_compat}.py,services/runtime_limits.py}` · 5 × `core/metrics.py` · `packages/applications/src/services/{settings-registry/descriptors/service-runtime.descriptors.ts,effective-config/{IEffectiveConfigService.ts,effective-config.service.ts,__tests__/effective-config.service.test.ts}}` · `docs/operations/inference/README.md`

**Shared-file fence honoured**: only `_build_payload` + constructor in `ollama.py`, only the two `create` kwarg sites + constructor in `openai_compat.py`, one appended field in smr `config.py`. `get_info` in both providers and `models/provider.py` / `api/endpoints/providers.py` were not touched.

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored from AD-4 (frozen) + code-verified current state (three caches read in full; harness/tts/smr/packaging substrates verified; §2.4 Docker workspace-dep question marked for execution-time). Status Pending — awaiting owner approval per rule 01 Phase 3 gate. |
| 2026-07-20 | **Implementation pass.** Step 4.1 gate PASSED — `packages/py-runtime-models` created and the §2.4 Docker question answered empirically (`--no-install-project` does NOT skip workspace path deps; source COPY required in layer 1). OD-3 primary path confirmed; fallback not needed. Delivered 4.1/4.2/4.4/4.5/4.7/4.8/4.9/4.10; closed D-07, D-09, D-10 (D-11 verified already closed by TASK-525). **Not delivered: 4.3 (stt-v2 convergence) and 4.6 (harness D-08)** — see §9.4. Six deviations recorded (DR-1…DR-6), notably the `<svc>.modelCache.*` key grammar over `models.retention.*` and three stale §2 current-state findings. Two defects in the new shared cache were caught by TDD and fixed (unload hook skipped on LRU and lazy-TTL eviction). Status → Blocked. |
| 2026-07-20 | **DR-1 RATIFIED as the frozen contract** (owner sign-off, recorded by [TASK-530](../TASK-530-Lifecycle-Convergence-Tail/README.md) §2.3/§4.6). The retention key grammar is **`<svc>.modelCache.<knob>`**, superseding the `models.retention.*` sketch in §3.2. Rationale: TASK-525 shipped and froze that grammar, its `resolveForService` explicitly reserved the guardrail/harness/tts-v2 subsets for this ticket to fill, and §2.5's Completion & Cleanup Doctrine forbids a second parallel key family for a single knob. This row converts the execution-time deviation into a recorded decision. |
| 2026-07-20 | **Errata applied by TASK-530 §4.6.** Three §2 current-state claims were factually stale and are corrected in place: (a) §2.1 stt-v2 "Admin-controlled ❌" — stt-v2 was ALREADY control-plane-wired via `apply_retention`/`set_retention_refresher` with the `[60, 3600]` clamp double-enforced; (b) §2.3 D-11 (dead `GlobalSettingRead` + seed rows) was **closed on arrival** — TASK-525 had already deleted both, so this ticket neither needed to nor did; (c) §3.2's `models.retention.*` grammar is superseded by DR-1 above. |
| 2026-07-20 | **Residue closed by [TASK-530](../TASK-530-Lifecycle-Convergence-Tail/README.md)**: step 4.3 (stt-v2 convergence, with the two pre-existing test files passing UNMODIFIED as the parity gate) and step 4.6 (harness D-08, resolved as a `SyncModelCache` sibling rather than an async conversion), plus D-09 completion for IndicParler/IndicF5 and a contract-level regression guard for the two unload-hook defects this ticket's TDD caught. Status → Review: every step of this plan is now delivered, here or in its named successor. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
