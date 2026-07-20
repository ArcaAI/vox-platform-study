# TASK-525 — Service Config Adoption: env → Effective-Config Pull Path

- **Status**: Pending
- **Type**: refactor / feature
- **Program**: Phase 1 of the [Agentic Platform Program plan (2026-07-20)](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) (§3 AD-1, §4 Phase 1); findings source: [2026-07-20 review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) (E2 §3, E6 §3, D-07, D-11, GAP-C2)
- **Suggested number**: TASK-525 per the program plan's allocation (highest allocated is TASK-522 + program children 523/524 — confirm at open time per the CLAUDE.md ticket workflow)
- **Size**: L
- **Lanes**: D (stt-v2) + E (smr, nlp, guardrail-exemplar) + B (the gateway internal route)
- **Dependencies**: **TASK-524** (settings write-lane, `AiRuntimeProfile`/`AiProviderConnection` tables, registry-key registration incl. the migrated `stt.config.*` keys, gateway-side profile injection into SMR/NLP requests). This ticket builds the read/pull side only.

---

## 1. Requirement Analysis

Owner expectation **E2** ("models and providers runtime-configurable, stored in DB … avoid env vars") and the config-delivery half of **E6** (retention/concurrency values must reach the services from the control plane, not env). The 2026-07-20 review quantified the gap: of 517 pydantic config fields across the six Python services, 248 model/provider/hyperparameter fields are env-only and **SMR has zero override mechanism of any kind** (findings §3-E2 item 1).

This ticket closes the **service side** of:

| ID | What | This ticket's share |
|---|---|---|
| **GAP-C2** | No DB/admin surface for hyperparameters, context length, concurrency, rate limits | The *pull path*: services consume `AiRuntimeProfile`-derived values (write surface + tables = TASK-524) |
| **D-07** | NLP model-cache retention not configurable at all (`ModelCache` ctor never passed ttl/max — `apps/nlp/src/nlp/services/model_cache.py:33-71` hardcoded `DEFAULT_MAX_SIZE = 3`, `DEFAULT_TTL_SECONDS = 3600`) | The **config-path part**: NLP gains a runtime config channel (effective-config client + semaphore). Retention *cache-behavior* adoption stays TASK-529 |
| **D-11** | stt-v2 `GlobalSettingRead` dead code + seeded `stt.config.*` rows with zero query sites | Delete the dead SQLAlchemy path; consume the replacement registry keys via the new client |

Deliverables (frozen in the program plan §4 TASK-525):

1. **(a)** NEW gateway internal route `GET /api/v1/internal/effective-config?service=<name>` (X-Service-Token guarded) returning the resolved per-service subset (retention, concurrency, runtime profiles, agentic-context).
2. **(b)** Per-service Python pull clients: 60 s TTL cache + negative-cache fail-safe to env (the guardrail `tenant_config.py` *pattern*, HTTP transport instead of its SQL).
3. **(c)** SMR providers consume injected `AiRuntimeProfile` params (temperature/max_tokens/timeouts) and resize per-provider semaphores on refresh **without dropping in-flight permits**.
4. **(d)** NLP gains the inference semaphore it lacks entirely (verified: zero `asyncio.Semaphore` hits under `apps/nlp/src`) + consumes injected params.
5. **(e)** stt-v2: delete dead `GlobalSettingRead`; consume `model_cache`/`workers` keys via the new client (registry-side key registration = TASK-524).
6. **(f)** Pydantic field docstrings annotated "bootstrap fallback — runtime value comes from the control plane".

**House constraint (selection stays per-request)**: SMR's stateless-gateway contract is preserved verbatim — "SMR is a stateless gateway: it does NOT select a provider or model from env. The gateway (apps/api) injects `{provider, model}` (DB-driven) on every request" (`apps/smr/src/smr_v2/core/config.py:1-9`). Effective-config carries **service-level knobs only**, never per-request model choice.

## 2. Current State Evaluation (code-verified 2026-07-20 working tree)

### 2.1 Gateway internal-route exemplars (apps/api)

- **`HarnessInternalController`** (`apps/api/src/modules/consultation/harness-internal.controller.ts:163-200`): the canonical service-token pattern — `@ApiExcludeController()` + `@Public()` + `@UseGuards(HarnessServiceTokenGuard)` at class level, `@Controller('internal/harness')` under the global `api/v1` prefix (only `/metrics` is excluded, `apps/api/src/main.ts`), so effective paths are `/api/v1/internal/harness/*`. The controller docstring (:158-161) documents that `@Public()` exempts the routes from the user-JWT chain **and the boot-time route-permission audit** while the explicitly-applied token guard still enforces auth. `HarnessServiceTokenGuard` (`apps/api/src/modules/consultation/harness-service-token.guard.ts`) resolves `HARNESS_SERVICE_TOKEN` via `SecretsService`, fail-closed, `timingSafeEqual` compare.
- **`SttInternalController`** (`apps/api/src/modules/internal/stt-internal.controller.ts:17-33`): the API-key variant — `@Authorize()` + per-route `ensureInternalApiKey(request.apiKey)`. stt-v2 presents `X-Internal-Service-Key` from its gateway client (`apps/stt-v2/src/stt_v2/core/api_client/gateway.py:38`, key from `settings.api_gateway_key`, `:439`).
- Home module for cross-service internal surfaces exists: `apps/api/src/modules/internal/internal.module.ts`.

### 2.2 The exemplar pull-cache: guardrail `tenant_config.py`

`apps/guardrail/src/guardrail/core/tenant_config.py` (read in full):

- `TenantConfigResolver` (`:163-316`): per-key TTL cache (`cache_ttl_s: int = 60`, `:171`), `time.monotonic` injection for fake-clock tests (`:172`), cache key `f"{task_key}::{tenant_id}"` (`:236`).
- **Negative caching is the load-bearing trick** (`:227-253`): a DB load error is caught, logged once (`guardrail.tenant_config.db_error`), and the *empty* result is cached for a full TTL window — "an unreachable DB costs at most one connection attempt per tenant per TTL window — not one per request". Callers then apply env defaults for any field still `None` (`:191-195`).
- `clear_cache()` test/admin helper (`:314-316`).
- Transport is SQLAlchemy+asyncpg against `AiTaskDefault ⋈ AiModel` — **this ticket reuses the cache/fail-safe mechanics, NOT the SQL transport**; the new clients speak HTTP to the gateway. Guardrail's own resolver is kept as-is per AD-1 ("guardrail's existing resolver … kept", plan §3 AD-1).

### 2.3 SMR — env-only knobs and the frozen-at-boot semaphores

- Provider configs, all env-only (`apps/smr/src/smr_v2/core/config.py`): `OllamaConfig` (`:17-26`, `SMR_V2_OLLAMA_` — `timeout_s=300`, `max_concurrent=4`), `AzureOpenAIConfig` (`:29-44` — `timeout_s=120`, `max_concurrent=10`, `tpm_limit=80_000`, `rpm_limit=480`), `BedrockConfig` (`:47-61`), `OpenAICompatConfig` (`:64-74`), `VllmConfig` (`:77-97`, `max_concurrent=8`), `LlamaCppConfig` (`:100-113`).
- **Hyperparameter resolution already accepts per-request values**: `GenerateRequest.temperature/max_tokens/top_p` are optional (`apps/smr/src/smr_v2/models/requests.py:26-28`) and `resolve_request_defaults` fills `None`s from hardcoded `GENERATION_DEFAULTS = {temperature: 0.1, max_tokens: 16_384, top_p: 0.95}` (`apps/smr/src/smr_v2/core/defaults.py:10-23`); all six providers call it (e.g. `providers/ollama.py:67-77`). So once TASK-524's gateway injection sends profile values in the request body, SMR consumes them with **zero provider changes** — this ticket's SMR work is the timeout/semaphore/service-level lane plus tests locking the injection contract.
- **Semaphore lifecycle** (`apps/smr/src/smr_v2/main.py:202-218`): `app.state.provider_semaphores` is built once in `lifespan` — plain `asyncio.Semaphore(max_conc)` per registered provider, `max_conc = getattr(cfg, "max_concurrent", 10)`. Accessor: `get_provider_semaphores` (`core/dependencies.py:77-80`). **Never resized after boot**; a runtime `max_concurrent` change today requires a redeploy.
- Inbound auth: `ServiceAuthMiddleware` (`apps/smr/src/smr_v2/api/middleware/auth.py:32-58`) — `hmac.compare_digest` on `X-Service-Token` vs `settings.service_token` (`SMR_V2_SERVICE_TOKEN`, `core/config.py:206`); empty token = dev bypass; health/docs/metrics exempt.
- **No gateway base-URL env var exists** (verified: no non-test `8868`/gateway-URL reference under `apps/smr/src` except CORS test fixtures). See §3.6.

### 2.4 NLP — no semaphore, no runtime channel

- **Zero `asyncio.Semaphore`** anywhere under `apps/nlp/src` (verified by grep 2026-07-20): concurrent NER/classification/diagnosis requests all pile onto the model unbounded (GAP-L4).
- Model identity is structurally env-unreachable (`_MODEL_IDENTITY_FIELDS` filtering, `apps/nlp/src/nlp/core/config.py:19,37-55`) — gateway-injected per request; tuning env (batch size, thresholds, `use_gpu`) still applies (`TextClassificationConfig` `:154-186`, `TokenClassificationConfig` `:189-222`, `MedicalSuggesterConfig` `:241-260`).
- Model caches are module-singleton `ModelCache(factory=…)` constructed with **no ttl/max args** (`apps/nlp/src/nlp/dependencies.py:98-113`) — D-07.
- Inbound token: `NLP_SERVICE_TOKEN` (`core/config.py:112-118`). **No gateway base-URL env var** (verified: zero `base_url`/`gateway_url` hits in non-test `apps/nlp/src`). See §3.6.

### 2.5 stt-v2 — dead DB-config path + env-only knobs, but the transport exists

- **Dead code (D-11)**: `GlobalSettingRead` (`apps/stt-v2/src/stt_v2/core/database/models.py:159-178`) + re-export (`core/database/__init__.py:9,16`). Verified zero callers: the only repo references are the class definition and the `__init__` re-export (grep over `apps/stt-v2/src` + `apps/stt-v2/tests`, 2026-07-20). The seed writes the rows it was meant to read: `stt.config.model_cache.{max_models,ttl_seconds,max_memory_mb}` + `stt.config.workers.{concurrency,batch_queue,streaming_queue}` (`packages/database/src/prisma/db_main/seed/06-stt.ts:1046-1115`).
- Env-only knobs this ticket wires: `model_cache_max_models` (default 5) / `model_cache_ttl_seconds` (default 3600, pydantic `ge=60, le=3600`) at `core/config/settings.py:132-145`, consumed by `models/cache.py:102-103`; `worker_concurrency` (`settings.py:312`); `streaming_max_concurrent` (`settings.py:417`, 0 = hardware auto-detect). Note: the cache's `max_memory_mb` has **no settings field at all** — hardcoded ctor fallback `10000` (`models/cache.py:101`); the seed row for it (`06-stt.ts:1071-1080`) never had a reader.
- **Gateway HTTP transport already exists**: `api_gateway_url` (default `http://localhost:8868/api/v1`), `api_gateway_key`, `api_gateway_timeout` (`settings.py:121-129`; bare env names `API_GATEWAY_URL`/`API_GATEWAY_KEY` — the Settings class has no env_prefix, `settings.py:596`) + the httpx client in `core/api_client/gateway.py`.

### 2.6 Harness (context, not in scope)

Harness already has a live per-run DB-driven pull (`fetch_policy` Temporal activity, `apps/harness/src/harness/temporal/activities.py:524-545`) and a gateway URL (`api_base_url = "http://localhost:8868"`, `core/config.py:301`, env `HARNESS_API_BASE_URL`). Its retention/agentic-context adoption belongs to TASK-529 / TASK-533-B; the endpoint contract here reserves its subset.

## 3. Architecture, Patterns & Best Practices

### 3.1 Pull + TTL + fail-safe-to-env (why not push)

Chosen: services **poll** `GET /api/v1/internal/effective-config?service=<name>` with a 60 s TTL cache. Rejected alternatives: push (gateway→service webhooks/SSE) needs new infra, retry semantics, and per-service listeners; direct DB reads would spread SQLAlchemy schema mirrors across four more services (guardrail's mirror already needs enum-sync discipline, `tenant_config.py:81-94`). Pull wins because:

- **Precedent is proven**: guardrail's resolver has run the exact TTL + negative-cache contract in production paths since TASK-338/506; harness `fetch_policy` proves per-run gateway pulls.
- **No new infra**: existing httpx clients, existing service tokens, existing internal-route pattern.
- **Deterministic degradation**: gateway down ⇒ one failed attempt per TTL window, then env/bootstrap values — the service's behavior is exactly today's (env-driven) behavior. Startup never blocks on the gateway (mirrors the harness "must come up even when Temporal is down" posture, rule 06).

### 3.2 Endpoint contract (frozen for TASK-529/533-B reuse)

```
GET /api/v1/internal/effective-config?service=<smr|nlp|stt-v2|guardrail|harness|tts-v2>
Headers: X-Service-Token: <that service's own token>
200 →
{
  "service": "smr",
  "generatedAt": "<ISO-8601>",
  "runtimeProfiles": [ { "provider": "ollama", "modelSlug": null, "temperature": …, "topP": …,
      "maxTokens": …, "contextLength": …, "maxConcurrent": …, "tpmLimit": …, "rpmLimit": …,
      "timeoutS": …, "keepAliveSeconds": …, "extraJson": {…}, "source": "db" } ],
  "retention":  { "ttlSeconds": …, "maxModels": …, "maxMemoryMb": …, "source": "db|env-fallback" },
  "concurrency": { "maxConcurrent": …, "workerConcurrency": …, "streamingMaxConcurrent": …, "source": … },
  "agenticContext": { … }   // served for harness/live-doc; consumed by TASK-533-B, not here
}
```

- Subsets are **per-service filtered** server-side (unknown `service` → 400): smr → `runtimeProfiles`; nlp → `runtimeProfiles` (its three task families) + `concurrency.maxConcurrent`; stt-v2 → `retention` (the migrated `stt.config.model_cache.*` keys) + `concurrency.{workerConcurrency,streamingMaxConcurrent}`; harness/tts-v2/guardrail → reserved subsets (empty until TASK-529). Omitted/null field ⇒ client keeps env/bootstrap value.
- Every group carries **`source: "db" | "env-fallback"`** (program plan §7 risk table: "Two registries during transition drift") — resolved from whether a DB row/registry override exists. Clients mirror the source into their **`/health` diagnostics block** (stt-v2 binding-health precedent), so operators can see per-key which lane is live.
- Resolution inside the gateway: settings-registry effective facade + `AiRuntimeProfile` repository reads — both TASK-524 deliverables (`packages/applications/src/services/settings-registry/effective-settings.service.ts` gains the override lane there). This ticket adds only a thin read service + controller.
- **Auth**: generalize the `HarnessServiceTokenGuard` pattern into an `InternalServiceTokenGuard` that validates `X-Service-Token` against the secret belonging to the requested `service` (`SMR_V2_SERVICE_TOKEN` / `NLP_SERVICE_TOKEN` / `GUARDRAIL_SERVICE_TOKEN` / `HARNESS_SERVICE_TOKEN` / `TTS_SERVICE_TOKEN` via `SecretsService`; verified names in `.env.example:277,409,496,549` — `SMR_V2_SERVICE_TOKEN`'s presence in `.env.example` **unverified**, confirm at implementation). stt-v2 authenticates with its existing `X-Internal-Service-Key` (accepted by the guard as an alternate header for `service=stt-v2` only, matching `SttInternalController`'s API-key posture). Fail-closed on unconfigured secret; `timingSafeEqual`. `@Public()` + `@ApiExcludeController()` + explicit `@UseGuards` — passes the boot-time route audit exactly like `HarnessInternalController` (its docstring `:158-161` is the citable precedent).

### 3.3 Python client pattern (per-service copy, one contract)

Per rule-06 conventions (ruff owns import order, `asyncio_mode=auto`), each service gets its own small module implementing one documented contract (mirrored implementation — the shared-package question is TASK-529's OD-3; do not preempt it):

- `fetch()` — httpx GET with the service's existing base URL + token; 5 s timeout (bounded, never blocks a request path longer than one attempt).
- **TTL cache**: `time.monotonic`-based, default 60 s, **jittered ±10 %** per instance (thundering-herd mitigation, §7) — the guardrail resolver's structure with a jitter term added.
- **Negative cache**: any fetch error → log once (`<svc>.effective_config.fetch_error`) → cache the *empty* result for one TTL window → callers fall back to env (guardrail `:227-253` semantics, verbatim).
- **Single-flight refresh**: an `asyncio.Lock` around the refresh so concurrent expirers trigger exactly one HTTP call (the model-cache single-flight precedent, `apps/stt-v2/src/stt_v2/models/cache.py`).
- Refresh is **read-triggered** (on access past expiry), not a background task — no new lifecycle to manage; a service that never reads never polls.
- `clear_cache()` + injectable `time_func`/transport for hermetic tests.

### 3.4 Semaphore resize without dropping in-flight permits

Problem: `asyncio.Semaphore` has no public resize; naively swapping `app.state.provider_semaphores[name]` with a new object while N requests hold permits on the old one transiently allows `old_in_flight + new_limit` concurrency (and the old waiters never see releases from new holders).

**Chosen approach — one long-lived `ResizableSemaphore` per provider, capacity adjusted in place** (rather than create-new-acquire-path/drain-old, which needs a two-object bookkeeping window and leaks the old object until drain):

- Wraps an internal `asyncio.Semaphore`-equivalent counter + waiter queue; `acquire`/`release` delegate.
- `set_limit(new)`: **grow** ⇒ release `(new - old)` extra permits immediately (wakes waiters); **shrink** ⇒ record a deficit; the next `(old - new)` `release()` calls are absorbed instead of freeing a permit. In-flight holders are never revoked; the bound converges as requests complete. Idempotent when the limit is unchanged.
- The object identity in `app.state.provider_semaphores` never changes, so `get_provider_semaphores` (`core/dependencies.py:77-80`) and every `async with` call site are untouched.
- Resize is driven by the effective-config client: on a refresh that changes a provider's `maxConcurrent`, call `set_limit`. NLP uses the same class for its single inference semaphore.

### 3.5 What each service consumes (this ticket)

| Service | Keys consumed | Applied to |
|---|---|---|
| smr | `runtimeProfiles[].{maxConcurrent, timeoutS}` (service-level) — temperature/topP/maxTokens arrive **per-request** via TASK-524 gateway injection | `ResizableSemaphore.set_limit` per provider; per-provider request timeout override (env fallback) |
| nlp | `concurrency.maxConcurrent`; injected per-request params (already-existing ctor path, `config.py:50-55`) | NEW inference semaphore wrapping model inference in the API routes |
| stt-v2 | `retention.{maxModels, ttlSeconds, maxMemoryMb}` + `concurrency.{workerConcurrency, streamingMaxConcurrent}` | `ModelCache` ctor/refresh values (clamp `[60, 3600]` stays double-enforced); worker/streaming ceilings read at their existing decision points |
| guardrail | none over HTTP — keeps its SQL resolver; **extends the SQL read with `AiRuntimeProfile` rows** (provider-level `temperature/maxTokens/timeoutS`) per plan §4-P1. `local_path` explicitly deferred to TASK-527 (D-12) | engine sub-config `model_copy(update=…)` (pattern at `tenant_config.py:343-353`) |
| harness / tts-v2 | none (reserved subsets; TASK-529/533-B) | — |

### 3.6 Env-var verification (house constraint: "none expected")

Verified per service: harness has `api_base_url` (`HARNESS_API_BASE_URL`, `core/config.py:301`) ✅ · stt-v2 has `API_GATEWAY_URL`/`API_GATEWAY_KEY` (`settings.py:121-129`) ✅ · guardrail needs none (SQL path kept) ✅ · **SMR and NLP have NO gateway base-URL var** (verified absent). ⚠️ **Deviation from the "no new env vars" expectation**: two new *bootstrap* vars are required — `SMR_V2_GATEWAY_URL` and `NLP_GATEWAY_URL` (default `http://localhost:8868/api/v1`). They go to `turbo.json#globalEnv` + `.env.example` + `.env.dev` per house rule. Flag to the owner at plan approval; the alternative (piggybacking service-level knobs on per-request injection) was rejected — it couples service config to request traffic and cannot deliver TASK-529's retention keys. No Python dependency additions expected (httpx present everywhere) ⇒ no `uv lock` unless implementation proves otherwise.

### 3.7 `/health` diagnostics block (uniform shape)

Each adopting service appends to its existing health payload (stt-v2 binding-health precedent):

```json
"effective_config": {
  "last_refresh_at": "<ISO-8601 | null>",
  "last_refresh_ok": true,
  "ttl_seconds": 60,
  "sources": { "retention": "db", "concurrency": "env-fallback" }
}
```

Health endpoints stay auth-exempt (they already are in every service's middleware exempt list, e.g. `apps/smr/src/smr_v2/api/middleware/auth.py:19-29`), so the block must never echo values that could be sensitive — **source labels and timestamps only, never the resolved values themselves**.

## 4. Implementation Plan (ordered; each step independently shippable after 4.1)

Step order and per-step gates (RED test list in §5; every step = its own reviewed commit):

| Step | Scope | Blocking on | Gate before next step |
|---|---|---|---|
| 4.1 | Gateway route + guard + read service (the frozen contract) | TASK-524 merged (facade + `AiRuntimeProfile` repo) | `pnpm --filter @arcaai/applications build test` · `pnpm build:api` · `pnpm test:unit` |
| 4.2 | SMR client + `ResizableSemaphore` + wiring | 4.1 | `pnpm py:smr-v2:test|lint|typecheck` |
| 4.3 | NLP client + inference semaphore | 4.1 (parallel to 4.2 — disjoint files) | `pnpm py:nlp:test` + lint/typecheck |
| 4.4 | stt-v2 client + `GlobalSettingRead` deletion + cache/worker consumption | 4.1 (parallel) | `pnpm py:stt-v2:test|lint|typecheck` |
| 4.5 | Guardrail SQL-read profile extension | TASK-524 tables migrated (no gateway dependency) | `pnpm py:guardrail:test|lint|typecheck` |
| 4.6 | Docstring/comment + env-file deltas | 4.2–4.5 + TASK-523's `.env.example` pass | `pnpm lint`; grep review |

### 4.1 Gateway route first — the contract (lane B)

| File | Action |
|---|---|
| `packages/applications/src/services/effective-config/effective-config.service.ts` (+ `IEffectiveConfigService.ts`, module, DTOs, `index.ts`, barrel) | NEW — resolves the per-service subset from the TASK-524 effective facade + `AiRuntimeProfileRepository`; stamps `source` per group |
| `apps/api/src/modules/internal/internal-service-token.guard.ts` | NEW — generalized per-service token guard (§3.2) |
| `apps/api/src/modules/internal/effective-config.controller.ts` | NEW — `@Controller('internal/effective-config')`, `@Public()` + guard + `@ApiExcludeController()` |
| `apps/api/src/modules/internal/internal.module.ts` | UPDATE — register controller + guard + service module |

### 4.2 SMR adoption (lane E)

| File | Action |
|---|---|
| `apps/smr/src/smr_v2/core/effective_config.py` | NEW — pull client (§3.3) |
| `apps/smr/src/smr_v2/services/resizable_semaphore.py` | NEW — `ResizableSemaphore` (§3.4) |
| `apps/smr/src/smr_v2/main.py` | UPDATE — build semaphores as `ResizableSemaphore` (`:202-218`); wire client refresh → `set_limit` + timeout overrides |
| `apps/smr/src/smr_v2/core/config.py` | UPDATE — `gateway_url` field (`SMR_V2_GATEWAY_URL`); docstring deltas (§4.6) |
| `apps/smr/src/smr_v2/core/dependencies.py` | UPDATE — expose the client (accessor only; semaphore accessor unchanged) |

### 4.3 NLP adoption (lane E)

| File | Action |
|---|---|
| `apps/nlp/src/nlp/core/effective_config.py` | NEW — pull client |
| `apps/nlp/src/nlp/core/concurrency.py` | NEW — inference `ResizableSemaphore` (mirrored class; module-singleton like `dependencies.py` caches) |
| `apps/nlp/src/nlp/api/…` (route modules invoking classifiers/suggester) + `dependencies.py` | UPDATE — wrap inference calls `async with` the semaphore (exact route files enumerated at implementation — inference entry points are the `get_*_for` consumers, `dependencies.py:116-120`) |
| `apps/nlp/src/nlp/core/config.py` | UPDATE — `gateway_url` on `NLPServiceConfig` (env `NLP_GATEWAY_URL`); docstrings |

### 4.4 stt-v2 adoption (lane D)

| File | Action |
|---|---|
| `apps/stt-v2/src/stt_v2/core/effective_config.py` | NEW — pull client reusing `api_gateway_url`/`api_gateway_key` (httpx pattern from `core/api_client/gateway.py`) |
| `apps/stt-v2/src/stt_v2/core/database/models.py` | UPDATE — **DELETE** `GlobalSettingRead` (`:159-178`) |
| `apps/stt-v2/src/stt_v2/core/database/__init__.py` | UPDATE — drop import + `__all__` entry (`:9,16`) |
| `apps/stt-v2/src/stt_v2/models/cache.py` | UPDATE — cache reads `max_models`/`ttl_seconds`/`max_memory_mb` through the client (env fallback; clamp preserved at `:102-103`) |
| `apps/stt-v2/src/stt_v2/core/config/settings.py` | UPDATE — docstrings only (`:132-145,312,417`) |
| worker/streaming ceiling read points | UPDATE — consult effective values where `worker_concurrency`/`streaming_max_concurrent` are read (sites enumerated at implementation) |

Coordination: the two seeded `stt.config.model_cache.*`/`stt.config.workers.*` GlobalSetting groups (`06-stt.ts:1046-1115`) migrate into registry keys **in TASK-524** (which owns the seed + registry files); this ticket only consumes. `stt.config.storage.*` (`:1117+`) is untouched.

### 4.5 Guardrail profile extension (lane E, small)

`apps/guardrail/src/guardrail/core/tenant_config.py`: add an `AiRuntimeProfileRead` mapping + include profile fields in the cached result; `resolve_guardian_engine` (`:319-353`) applies temperature/timeout via the existing `model_copy` path. No transport change; `local_path` stays out (TASK-527).

### 4.6 Docstring/comment deltas (part of DoD)

- Every pydantic field this ticket puts under control-plane authority gains: *"bootstrap fallback — runtime value comes from the control plane (effective-config)"* — SMR provider configs (`config.py:17-113` max_concurrent/timeout fields), NLP `NLPServiceConfig` additions, stt-v2 `settings.py:132-145,312,417`.
- `apps/smr/src/smr_v2/core/config.py:1-9` module docstring: append one line noting service-level knobs now refresh via effective-config (selection contract unchanged).
- `tenant_config.py` module docstring: note the profile extension.
- `.env.example`: annotate the touched sections "bootstrap fallback only" + add the two new vars (coordinate with TASK-523's D-15 hygiene pass to avoid a file collision — sequence after it).

### Ownership manifest (exclusive)

`packages/applications/src/services/effective-config/**` · `apps/api/src/modules/internal/**` · `apps/smr/src/smr_v2/{core/effective_config.py,core/config.py,core/dependencies.py,main.py,services/resizable_semaphore.py}` · `apps/nlp/src/nlp/{core/effective_config.py,core/concurrency.py,core/config.py,dependencies.py,api/**}` · `apps/stt-v2/src/stt_v2/{core/effective_config.py,core/database/**,models/cache.py,core/config/settings.py}` · `apps/guardrail/src/guardrail/core/tenant_config.py` · colocated tests. Barrel edits append-only (program §7). **Not owned**: seeds, prisma, settings-registry (TASK-524); `.env.example` sequenced after TASK-523.

### Out of scope

Retention/VRAM *cache behavior* + shared py package + Ollama `keep_alive` (TASK-529) · per-request model selection (unchanged, house constraint) · `agentic.context.*` consumption (TASK-533-B) · `local_path`/S3 sources (TASK-527) · BYO credentials (TASK-526) · harness/tts-v2 adoption (TASK-529).

## 5. TDD Plan (RED first — paste failing runs in this README before implementing)

Hermetic throughout: the gateway is stubbed with a local fixture HTTP server (per-service pytest fixture spinning an `aiohttp`/`uvicorn`-free `asyncio` HTTP stub or `httpx.MockTransport`); no live DB/gateway; fake clocks via injected `time_func`; `asyncio_mode=auto`.

| # | Test (RED first) | Path |
|---|---|---|
| 1 | Controller: valid per-service token → 200 subset; missing/invalid token → 401; unconfigured secret → 401 (fail-closed); unknown `service` → 400; subset filtered per service; `source` stamped | `apps/api/src/modules/internal/__tests__/effective-config.controller.test.ts` |
| 2 | Boot-audit compliance: route carries `@Public()` + explicit guard (mirrors harness-internal precedent) — asserted via the route-audit unit harness | same file |
| 3 | SMR client: "profile value present → overrides env default"; "gateway unreachable → env fallback + exactly one attempt per TTL window (negative cache)"; "TTL expiry → single-flight refresh (one HTTP call under concurrency)"; jitter bounds | `apps/smr/src/smr_v2/tests/unit/test_effective_config_client.py` |
| 4 | **"semaphore resize preserves in-flight permits"**: acquire 3 of 4 → `set_limit(2)` → no revocation, new acquires blocked until deficit absorbed, converges to 2; grow wakes waiters; identity stable | `apps/smr/src/smr_v2/tests/unit/test_resizable_semaphore.py` |
| 5 | SMR wiring: refreshed `maxConcurrent` reaches `app.state.provider_semaphores[name]`; per-provider `timeoutS` override applied; provider/model selection untouched (docstring contract regression) | `apps/smr/src/smr_v2/tests/unit/test_effective_config_wiring.py` |
| 6 | **"nlp bounds concurrent inference"**: N+1 concurrent requests → at most N in the model section (instrumented fake classifier); limit resizes on refresh | `apps/nlp/tests/test_inference_semaphore.py` |
| 7 | NLP client: fallback/negative-cache/single-flight (mirror of #3) | `apps/nlp/tests/test_effective_config_client.py` |
| 8 | **"stt-v2 consumes model_cache keys via client; GlobalSettingRead gone"**: cache picks up served `ttl_seconds`/`max_models` (clamp still enforced: served 30 → 60); `from stt_v2.core.database import GlobalSettingRead` raises `ImportError`; grep-style assert zero references | `apps/stt-v2/tests/unit/test_effective_config_client.py`, `apps/stt-v2/tests/unit/test_database_exports.py` |
| 9 | Guardrail: profile fields ride the existing cache entry; DB error still → env fallback (existing tests extended, not weakened) | guardrail in-package tests (`apps/guardrail/src/guardrail/tests/`) |

**Gates** (all pasted as evidence): `pnpm --filter @arcaai/applications build test` · `pnpm build:api` + `pnpm test:unit` · `pnpm py:smr-v2:test|lint|typecheck` · `pnpm py:nlp:test` + `py:nlp:lint|typecheck` · `pnpm py:stt-v2:test|lint|typecheck` · `pnpm py:guardrail:test|lint|typecheck` · `pnpm lint`. E2E (route reachable with real tokens) authored here, executed in Phase 7 (TASK-534).

## 6. Acceptance & Definition of Done

- [ ] `GET /api/v1/internal/effective-config?service=<name>` live for the six service names; per-service token auth fail-closed; excluded from Swagger; boot audit passes.
- [ ] SMR/NLP/stt-v2 pull clients: 60 s jittered TTL, negative cache, single-flight, env fail-safe — behavior with the gateway down is byte-identical to today's env-driven behavior (program §7 discipline).
- [ ] SMR semaphores resize live without dropping in-flight permits; NLP inference bounded by a live-resizable semaphore.
- [ ] stt-v2 `GlobalSettingRead` + re-export deleted; `model_cache`/`workers` values control-plane-driven with clamp intact (D-11, D-07-config-path closed).
- [ ] `source: db|env-fallback` visible in each service's `/health` diagnostics block.
- [ ] Docstring deltas (§4.6) landed; two new bootstrap vars in `turbo.json#globalEnv` + `.env.example` + `.env.dev` **with owner ack of the deviation**; no other new env vars; `uv lock` untouched unless a dep was added.
- [ ] All gate outputs pasted; RED runs recorded; no new lint/mypy findings; seed-count tests untouched (no seed changes here).

## 7. Risks & Rollback

| Risk | Mitigation |
|---|---|
| **Config flap during refresh** (a mid-window admin edit makes concurrent requests see different values) | Values applied only at refresh boundaries (one atomic snapshot swap per client); semaphore converges monotonically (§3.4); clamps (`[60, 3600]` TTL, `ge=1` concurrency) enforced client-side regardless of served values |
| **Thundering herd on gateway restart** (all services' TTLs expire together) | ±10 % per-instance jitter on TTL + single-flight per process + negative cache (a failing gateway absorbs ≤ 1 request/service/TTL) |
| **Env drift masked** (operator sets env, DB silently wins — or vice versa) | `source` field per group + `/health` diagnostics (§3.2); `.env.example` fallback-only annotations; the findings' D-15 lesson |
| Silent behavior change on adoption (the D-07 lesson: wiring a dead field flips real defaults) | Every consumed key's DB default is seeded (TASK-524) to reproduce today's effective env value byte-for-byte; deviations are reviewed decision rows |
| Semaphore shrink starves under sustained load (deficit never absorbed if requests are long-lived) | Deficit absorption is per-release, bounded by old−new; test #4 locks convergence; log a warning if a deficit persists > 5 min |
| SMR/NLP new env vars conflict with "avoid env" optics | They are *bootstrap transport* vars (where the control plane lives), not config authority — documented as such; flagged to owner (§3.6) |
| **Rollback** | Pure-additive: unset/ignore the gateway route (services negative-cache into env behavior); revert the client wiring commits per service independently; the stt-v2 model deletion is trivially revertable (read-only mapping, no migration) |

## 8. References

- Program plan §3 AD-1/AD-2, §4 Phase 1 TASK-525 — `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-program-plan.md`
- Findings §3-E2/E6, D-07, D-11, GAP-C2/L4 — `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-review-findings.md`
- Exemplars: `apps/guardrail/src/guardrail/core/tenant_config.py` (pull cache) · `apps/api/src/modules/consultation/harness-internal.controller.ts` + `harness-service-token.guard.ts` (internal route/auth) · `apps/api/src/modules/internal/stt-internal.controller.ts` (API-key variant) · `apps/smr/src/smr_v2/api/middleware/auth.py` (service-token middleware)
- Key sites: `apps/smr/src/smr_v2/main.py:202-218` · `core/defaults.py:10-23` · `apps/nlp/src/nlp/dependencies.py:98-120` · `apps/stt-v2/src/stt_v2/core/database/models.py:159-178` · `core/config/settings.py:121-145,312,417` · `packages/database/src/prisma/db_main/seed/06-stt.ts:1046-1115`
- Rules: 01 (lifecycle/TDD), 05 (internal routes, boot audit), 06 (Python services, test placement)

## 9. Implementation Summary

_Pending_

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored (execution-ready): code-verified current state, frozen endpoint contract, semaphore-resize design, ordered per-service plan, RED-first TDD list, env-var deviation flagged (SMR/NLP gateway URL vars). Status Pending — awaiting owner approval + TASK-524. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
