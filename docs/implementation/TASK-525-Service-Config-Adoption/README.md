# TASK-525 — Service Config Adoption: env → Effective-Config Pull Path

- **Status**: Review — implementation COMPLETE (steps 4.1–4.6), every static gate green (§9.6). Owner takes runtime verification (§9.9).
- **Type**: refactor / feature
- **Program**: Phase 1 of the [Agentic Platform Program plan (2026-07-20)](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) (§3 AD-1, §4 Phase 1); findings source: [2026-07-20 review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) (E2 §3, E6 §3, D-07, D-11, GAP-C2)
- **Suggested number**: TASK-525 per the program plan's allocation (highest allocated is TASK-522 + program children 523/524 — confirm at open time per the CLAUDE.md ticket workflow)
- **Size**: L
- **Lanes**: D (stt) + E (smr, nlp, guardrail-exemplar) + B (the gateway internal route)
- **Dependencies**: **TASK-524** (settings write-lane, `AiRuntimeProfile`/`AiProviderConnection` tables, registry-key registration incl. the migrated `stt.config.*` keys, gateway-side profile injection into SMR/NLP requests). This ticket builds the read/pull side only.

---

## 1. Requirement Analysis

Owner expectation **E2** ("models and providers runtime-configurable, stored in DB … avoid env vars") and the config-delivery half of **E6** (retention/concurrency values must reach the services from the control plane, not env). The 2026-07-20 review quantified the gap: of 517 pydantic config fields across the six Python services, 248 model/provider/hyperparameter fields are env-only and **SMR has zero override mechanism of any kind** (findings §3-E2 item 1).

This ticket closes the **service side** of:

| ID | What | This ticket's share |
|---|---|---|
| **GAP-C2** | No DB/admin surface for hyperparameters, context length, concurrency, rate limits | The *pull path*: services consume `AiRuntimeProfile`-derived values (write surface + tables = TASK-524) |
| **D-07** | NLP model-cache retention not configurable at all (`ModelCache` ctor never passed ttl/max — `apps/nlp/src/nlp/services/model_cache.py:33-71` hardcoded `DEFAULT_MAX_SIZE = 3`, `DEFAULT_TTL_SECONDS = 3600`) | The **config-path part**: NLP gains a runtime config channel (effective-config client + semaphore). Retention *cache-behavior* adoption stays TASK-529 |
| **D-11** | stt `GlobalSettingRead` dead code + seeded `stt.config.*` rows with zero query sites | Delete the dead SQLAlchemy path; consume the replacement registry keys via the new client |

Deliverables (frozen in the program plan §4 TASK-525):

1. **(a)** NEW gateway internal route `GET /api/v1/internal/effective-config?service=<name>` (X-Service-Token guarded) returning the resolved per-service subset (retention, concurrency, runtime profiles, agentic-context).
2. **(b)** Per-service Python pull clients: 60 s TTL cache + negative-cache fail-safe to env (the guardrail `tenant_config.py` *pattern*, HTTP transport instead of its SQL).
3. **(c)** SMR providers consume injected `AiRuntimeProfile` params (temperature/max_tokens/timeouts) and resize per-provider semaphores on refresh **without dropping in-flight permits**.
4. **(d)** NLP gains the inference semaphore it lacks entirely (verified: zero `asyncio.Semaphore` hits under `apps/nlp/src`) + consumes injected params.
5. **(e)** stt: delete dead `GlobalSettingRead`; consume `model_cache`/`workers` keys via the new client (registry-side key registration = TASK-524).
6. **(f)** Pydantic field docstrings annotated "bootstrap fallback — runtime value comes from the control plane".

**House constraint (selection stays per-request)**: SMR's stateless-gateway contract is preserved verbatim — "SMR is a stateless gateway: it does NOT select a provider or model from env. The gateway (apps/api) injects `{provider, model}` (DB-driven) on every request" (`apps/smr/src/smr/core/config.py:1-9`). Effective-config carries **service-level knobs only**, never per-request model choice.

## 2. Current State Evaluation (code-verified 2026-07-20 working tree)

### 2.1 Gateway internal-route exemplars (apps/api)

- **`HarnessInternalController`** (`apps/api/src/modules/consultation/harness-internal.controller.ts:163-200`): the canonical service-token pattern — `@ApiExcludeController()` + `@Public()` + `@UseGuards(HarnessServiceTokenGuard)` at class level, `@Controller('internal/harness')` under the global `api/v1` prefix (only `/metrics` is excluded, `apps/api/src/main.ts`), so effective paths are `/api/v1/internal/harness/*`. The controller docstring (:158-161) documents that `@Public()` exempts the routes from the user-JWT chain **and the boot-time route-permission audit** while the explicitly-applied token guard still enforces auth. `HarnessServiceTokenGuard` (`apps/api/src/modules/consultation/harness-service-token.guard.ts`) resolves `HARNESS_SERVICE_TOKEN` via `SecretsService`, fail-closed, `timingSafeEqual` compare.
- **`SttInternalController`** (`apps/api/src/modules/internal/stt-internal.controller.ts:17-33`): the API-key variant — `@Authorize()` + per-route `ensureInternalApiKey(request.apiKey)`. stt presents `X-Internal-Service-Key` from its gateway client (`apps/stt/src/stt/core/api_client/gateway.py:38`, key from `settings.api_gateway_key`, `:439`).
- Home module for cross-service internal surfaces exists: `apps/api/src/modules/internal/internal.module.ts`.

### 2.2 The exemplar pull-cache: guardrail `tenant_config.py`

`apps/guardrail/src/guardrail/core/tenant_config.py` (read in full):

- `TenantConfigResolver` (`:163-316`): per-key TTL cache (`cache_ttl_s: int = 60`, `:171`), `time.monotonic` injection for fake-clock tests (`:172`), cache key `f"{task_key}::{tenant_id}"` (`:236`).
- **Negative caching is the load-bearing trick** (`:227-253`): a DB load error is caught, logged once (`guardrail.tenant_config.db_error`), and the *empty* result is cached for a full TTL window — "an unreachable DB costs at most one connection attempt per tenant per TTL window — not one per request". Callers then apply env defaults for any field still `None` (`:191-195`).
- `clear_cache()` test/admin helper (`:314-316`).
- Transport is SQLAlchemy+asyncpg against `AiTaskDefault ⋈ AiModel` — **this ticket reuses the cache/fail-safe mechanics, NOT the SQL transport**; the new clients speak HTTP to the gateway. Guardrail's own resolver is kept as-is per AD-1 ("guardrail's existing resolver … kept", plan §3 AD-1).

### 2.3 SMR — env-only knobs and the frozen-at-boot semaphores

- Provider configs, all env-only (`apps/smr/src/smr/core/config.py`): `OllamaConfig` (`:17-26`, `SMR_OLLAMA_` — `timeout_s=300`, `max_concurrent=4`), `AzureOpenAIConfig` (`:29-44` — `timeout_s=120`, `max_concurrent=10`, `tpm_limit=80_000`, `rpm_limit=480`), `BedrockConfig` (`:47-61`), `OpenAICompatConfig` (`:64-74`), `VllmConfig` (`:77-97`, `max_concurrent=8`), `LlamaCppConfig` (`:100-113`).
- **Hyperparameter resolution already accepts per-request values**: `GenerateRequest.temperature/max_tokens/top_p` are optional (`apps/smr/src/smr/models/requests.py:26-28`) and `resolve_request_defaults` fills `None`s from hardcoded `GENERATION_DEFAULTS = {temperature: 0.1, max_tokens: 16_384, top_p: 0.95}` (`apps/smr/src/smr/core/defaults.py:10-23`); all six providers call it (e.g. `providers/ollama.py:67-77`). So once TASK-524's gateway injection sends profile values in the request body, SMR consumes them with **zero provider changes** — this ticket's SMR work is the timeout/semaphore/service-level lane plus tests locking the injection contract.
- **Semaphore lifecycle** (`apps/smr/src/smr/main.py:202-218`): `app.state.provider_semaphores` is built once in `lifespan` — plain `asyncio.Semaphore(max_conc)` per registered provider, `max_conc = getattr(cfg, "max_concurrent", 10)`. Accessor: `get_provider_semaphores` (`core/dependencies.py:77-80`). **Never resized after boot**; a runtime `max_concurrent` change today requires a redeploy.
- Inbound auth: `ServiceAuthMiddleware` (`apps/smr/src/smr/api/middleware/auth.py:32-58`) — `hmac.compare_digest` on `X-Service-Token` vs `settings.service_token` (`SMR_SERVICE_TOKEN`, `core/config.py:206`); empty token = dev bypass; health/docs/metrics exempt.
- **No gateway base-URL env var exists** (verified: no non-test `8868`/gateway-URL reference under `apps/smr/src` except CORS test fixtures). See §3.6.

### 2.4 NLP — no semaphore, no runtime channel

- **Zero `asyncio.Semaphore`** anywhere under `apps/nlp/src` (verified by grep 2026-07-20): concurrent NER/classification/diagnosis requests all pile onto the model unbounded (GAP-L4).
- Model identity is structurally env-unreachable (`_MODEL_IDENTITY_FIELDS` filtering, `apps/nlp/src/nlp/core/config.py:19,37-55`) — gateway-injected per request; tuning env (batch size, thresholds, `use_gpu`) still applies (`TextClassificationConfig` `:154-186`, `TokenClassificationConfig` `:189-222`, `MedicalSuggesterConfig` `:241-260`).
- Model caches are module-singleton `ModelCache(factory=…)` constructed with **no ttl/max args** (`apps/nlp/src/nlp/dependencies.py:98-113`) — D-07.
- Inbound token: `NLP_SERVICE_TOKEN` (`core/config.py:112-118`). **No gateway base-URL env var** (verified: zero `base_url`/`gateway_url` hits in non-test `apps/nlp/src`). See §3.6.

### 2.5 stt — dead DB-config path + env-only knobs, but the transport exists

- **Dead code (D-11)**: `GlobalSettingRead` (`apps/stt/src/stt/core/database/models.py:159-178`) + re-export (`core/database/__init__.py:9,16`). Verified zero callers: the only repo references are the class definition and the `__init__` re-export (grep over `apps/stt/src` + `apps/stt/tests`, 2026-07-20). The seed writes the rows it was meant to read: `stt.config.model_cache.{max_models,ttl_seconds,max_memory_mb}` + `stt.config.workers.{concurrency,batch_queue,streaming_queue}` (`packages/database/src/prisma/db_main/seed/06-stt.ts:1046-1115`).
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
GET /api/v1/internal/effective-config?service=<smr|nlp|stt|guardrail|harness|tts>
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

- Subsets are **per-service filtered** server-side (unknown `service` → 400): smr → `runtimeProfiles`; nlp → `runtimeProfiles` (its three task families) + `concurrency.maxConcurrent`; stt → `retention` (the migrated `stt.config.model_cache.*` keys) + `concurrency.{workerConcurrency,streamingMaxConcurrent}`; harness/tts/guardrail → reserved subsets (empty until TASK-529). Omitted/null field ⇒ client keeps env/bootstrap value.
- Every group carries **`source: "db" | "env-fallback"`** (program plan §7 risk table: "Two registries during transition drift") — resolved from whether a DB row/registry override exists. Clients mirror the source into their **`/health` diagnostics block** (stt binding-health precedent), so operators can see per-key which lane is live.
- Resolution inside the gateway: settings-registry effective facade + `AiRuntimeProfile` repository reads — both TASK-524 deliverables (`packages/applications/src/services/settings-registry/effective-settings.service.ts` gains the override lane there). This ticket adds only a thin read service + controller.
- **Auth**: generalize the `HarnessServiceTokenGuard` pattern into an `InternalServiceTokenGuard` that validates `X-Service-Token` against the secret belonging to the requested `service` (`SMR_SERVICE_TOKEN` / `NLP_SERVICE_TOKEN` / `GUARDRAIL_SERVICE_TOKEN` / `HARNESS_SERVICE_TOKEN` / `TTS_SERVICE_TOKEN` via `SecretsService`; verified names in `.env.example:277,409,496,549` — `SMR_SERVICE_TOKEN`'s presence in `.env.example` **unverified**, confirm at implementation). stt authenticates with its existing `X-Internal-Service-Key` (accepted by the guard as an alternate header for `service=stt` only, matching `SttInternalController`'s API-key posture). Fail-closed on unconfigured secret; `timingSafeEqual`. `@Public()` + `@ApiExcludeController()` + explicit `@UseGuards` — passes the boot-time route audit exactly like `HarnessInternalController` (its docstring `:158-161` is the citable precedent).

### 3.3 Python client pattern (per-service copy, one contract)

Per rule-06 conventions (ruff owns import order, `asyncio_mode=auto`), each service gets its own small module implementing one documented contract (mirrored implementation — the shared-package question is TASK-529's OD-3; do not preempt it):

- `fetch()` — httpx GET with the service's existing base URL + token; 5 s timeout (bounded, never blocks a request path longer than one attempt).
- **TTL cache**: `time.monotonic`-based, default 60 s, **jittered ±10 %** per instance (thundering-herd mitigation, §7) — the guardrail resolver's structure with a jitter term added.
- **Negative cache**: any fetch error → log once (`<svc>.effective_config.fetch_error`) → cache the *empty* result for one TTL window → callers fall back to env (guardrail `:227-253` semantics, verbatim).
- **Single-flight refresh**: an `asyncio.Lock` around the refresh so concurrent expirers trigger exactly one HTTP call (the model-cache single-flight precedent, `apps/stt/src/stt/models/cache.py`).
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
| stt | `retention.{maxModels, ttlSeconds, maxMemoryMb}` + `concurrency.{workerConcurrency, streamingMaxConcurrent}` | `ModelCache` ctor/refresh values (clamp `[60, 3600]` stays double-enforced); worker/streaming ceilings read at their existing decision points |
| guardrail | none over HTTP — keeps its SQL resolver; **extends the SQL read with `AiRuntimeProfile` rows** (provider-level `temperature/maxTokens/timeoutS`) per plan §4-P1. `local_path` explicitly deferred to TASK-527 (D-12) | engine sub-config `model_copy(update=…)` (pattern at `tenant_config.py:343-353`) |
| harness / tts | none (reserved subsets; TASK-529/533-B) | — |

### 3.6 Env-var verification (house constraint: "none expected")

Verified per service: harness has `api_base_url` (`HARNESS_API_BASE_URL`, `core/config.py:301`) ✅ · stt has `API_GATEWAY_URL`/`API_GATEWAY_KEY` (`settings.py:121-129`) ✅ · guardrail needs none (SQL path kept) ✅ · **SMR and NLP have NO gateway base-URL var** (verified absent). ⚠️ **Deviation from the "no new env vars" expectation**: two new *bootstrap* vars are required — `SMR_GATEWAY_URL` and `NLP_GATEWAY_URL` (default `http://localhost:8868/api/v1`). They go to `turbo.json#globalEnv` + `.env.example` + `.env.dev` per house rule. Flag to the owner at plan approval; the alternative (piggybacking service-level knobs on per-request injection) was rejected — it couples service config to request traffic and cannot deliver TASK-529's retention keys. No Python dependency additions expected (httpx present everywhere) ⇒ no `uv lock` unless implementation proves otherwise.

### 3.7 `/health` diagnostics block (uniform shape)

Each adopting service appends to its existing health payload (stt binding-health precedent):

```json
"effective_config": {
  "last_refresh_at": "<ISO-8601 | null>",
  "last_refresh_ok": true,
  "ttl_seconds": 60,
  "sources": { "retention": "db", "concurrency": "env-fallback" }
}
```

Health endpoints stay auth-exempt (they already are in every service's middleware exempt list, e.g. `apps/smr/src/smr/api/middleware/auth.py:19-29`), so the block must never echo values that could be sensitive — **source labels and timestamps only, never the resolved values themselves**.

## 4. Implementation Plan (ordered; each step independently shippable after 4.1)

Step order and per-step gates (RED test list in §5; every step = its own reviewed commit):

| Step | Scope | Blocking on | Gate before next step |
|---|---|---|---|
| 4.1 | Gateway route + guard + read service (the frozen contract) | TASK-524 merged (facade + `AiRuntimeProfile` repo) | `pnpm --filter @arcaai/applications build test` · `pnpm build:api` · `pnpm test:unit` |
| 4.2 | SMR client + `ResizableSemaphore` + wiring | 4.1 | `pnpm py:smr:test|lint|typecheck` |
| 4.3 | NLP client + inference semaphore | 4.1 (parallel to 4.2 — disjoint files) | `pnpm py:nlp:test` + lint/typecheck |
| 4.4 | stt client + `GlobalSettingRead` deletion + cache/worker consumption | 4.1 (parallel) | `pnpm py:stt:test|lint|typecheck` |
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
| `apps/smr/src/smr/core/effective_config.py` | NEW — pull client (§3.3) |
| `apps/smr/src/smr/services/resizable_semaphore.py` | NEW — `ResizableSemaphore` (§3.4) |
| `apps/smr/src/smr/main.py` | UPDATE — build semaphores as `ResizableSemaphore` (`:202-218`); wire client refresh → `set_limit` + timeout overrides |
| `apps/smr/src/smr/core/config.py` | UPDATE — `gateway_url` field (`SMR_GATEWAY_URL`); docstring deltas (§4.6) |
| `apps/smr/src/smr/core/dependencies.py` | UPDATE — expose the client (accessor only; semaphore accessor unchanged) |

### 4.3 NLP adoption (lane E)

| File | Action |
|---|---|
| `apps/nlp/src/nlp/core/effective_config.py` | NEW — pull client |
| `apps/nlp/src/nlp/core/concurrency.py` | NEW — inference `ResizableSemaphore` (mirrored class; module-singleton like `dependencies.py` caches) |
| `apps/nlp/src/nlp/api/…` (route modules invoking classifiers/suggester) + `dependencies.py` | UPDATE — wrap inference calls `async with` the semaphore (exact route files enumerated at implementation — inference entry points are the `get_*_for` consumers, `dependencies.py:116-120`) |
| `apps/nlp/src/nlp/core/config.py` | UPDATE — `gateway_url` on `NLPServiceConfig` (env `NLP_GATEWAY_URL`); docstrings |

### 4.4 stt adoption (lane D)

| File | Action |
|---|---|
| `apps/stt/src/stt/core/effective_config.py` | NEW — pull client reusing `api_gateway_url`/`api_gateway_key` (httpx pattern from `core/api_client/gateway.py`) |
| `apps/stt/src/stt/core/database/models.py` | UPDATE — **DELETE** `GlobalSettingRead` (`:159-178`) |
| `apps/stt/src/stt/core/database/__init__.py` | UPDATE — drop import + `__all__` entry (`:9,16`) |
| `apps/stt/src/stt/models/cache.py` | UPDATE — cache reads `max_models`/`ttl_seconds`/`max_memory_mb` through the client (env fallback; clamp preserved at `:102-103`) |
| `apps/stt/src/stt/core/config/settings.py` | UPDATE — docstrings only (`:132-145,312,417`) |
| worker/streaming ceiling read points | UPDATE — consult effective values where `worker_concurrency`/`streaming_max_concurrent` are read (sites enumerated at implementation) |

Coordination: the two seeded `stt.config.model_cache.*`/`stt.config.workers.*` GlobalSetting groups (`06-stt.ts:1046-1115`) migrate into registry keys **in TASK-524** (which owns the seed + registry files); this ticket only consumes. `stt.config.storage.*` (`:1117+`) is untouched.

### 4.5 Guardrail profile extension (lane E, small)

`apps/guardrail/src/guardrail/core/tenant_config.py`: add an `AiRuntimeProfileRead` mapping + include profile fields in the cached result; `resolve_guardian_engine` (`:319-353`) applies temperature/timeout via the existing `model_copy` path. No transport change; `local_path` stays out (TASK-527).

### 4.6 Docstring/comment deltas (part of DoD)

- Every pydantic field this ticket puts under control-plane authority gains: *"bootstrap fallback — runtime value comes from the control plane (effective-config)"* — SMR provider configs (`config.py:17-113` max_concurrent/timeout fields), NLP `NLPServiceConfig` additions, stt `settings.py:132-145,312,417`.
- `apps/smr/src/smr/core/config.py:1-9` module docstring: append one line noting service-level knobs now refresh via effective-config (selection contract unchanged).
- `tenant_config.py` module docstring: note the profile extension.
- `.env.example`: annotate the touched sections "bootstrap fallback only" + add the two new vars (coordinate with TASK-523's D-15 hygiene pass to avoid a file collision — sequence after it).

### Ownership manifest (exclusive)

`packages/applications/src/services/effective-config/**` · `apps/api/src/modules/internal/**` · `apps/smr/src/smr/{core/effective_config.py,core/config.py,core/dependencies.py,main.py,services/resizable_semaphore.py}` · `apps/nlp/src/nlp/{core/effective_config.py,core/concurrency.py,core/config.py,dependencies.py,api/**}` · `apps/stt/src/stt/{core/effective_config.py,core/database/**,models/cache.py,core/config/settings.py}` · `apps/guardrail/src/guardrail/core/tenant_config.py` · colocated tests. Barrel edits append-only (program §7). **Not owned**: seeds, prisma, settings-registry (TASK-524); `.env.example` sequenced after TASK-523.

### Out of scope

Retention/VRAM *cache behavior* + shared py package + Ollama `keep_alive` (TASK-529) · per-request model selection (unchanged, house constraint) · `agentic.context.*` consumption (TASK-533-B) · `local_path`/S3 sources (TASK-527) · BYO credentials (TASK-526) · harness/tts adoption (TASK-529).

## 5. TDD Plan (RED first — paste failing runs in this README before implementing)

Hermetic throughout: the gateway is stubbed with a local fixture HTTP server (per-service pytest fixture spinning an `aiohttp`/`uvicorn`-free `asyncio` HTTP stub or `httpx.MockTransport`); no live DB/gateway; fake clocks via injected `time_func`; `asyncio_mode=auto`.

| # | Test (RED first) | Path |
|---|---|---|
| 1 | Controller: valid per-service token → 200 subset; missing/invalid token → 401; unconfigured secret → 401 (fail-closed); unknown `service` → 400; subset filtered per service; `source` stamped | `apps/api/src/modules/internal/__tests__/effective-config.controller.test.ts` |
| 2 | Boot-audit compliance: route carries `@Public()` + explicit guard (mirrors harness-internal precedent) — asserted via the route-audit unit harness | same file |
| 3 | SMR client: "profile value present → overrides env default"; "gateway unreachable → env fallback + exactly one attempt per TTL window (negative cache)"; "TTL expiry → single-flight refresh (one HTTP call under concurrency)"; jitter bounds | `apps/smr/src/smr/tests/unit/test_effective_config_client.py` |
| 4 | **"semaphore resize preserves in-flight permits"**: acquire 3 of 4 → `set_limit(2)` → no revocation, new acquires blocked until deficit absorbed, converges to 2; grow wakes waiters; identity stable | `apps/smr/src/smr/tests/unit/test_resizable_semaphore.py` |
| 5 | SMR wiring: refreshed `maxConcurrent` reaches `app.state.provider_semaphores[name]`; per-provider `timeoutS` override applied; provider/model selection untouched (docstring contract regression) | `apps/smr/src/smr/tests/unit/test_effective_config_wiring.py` |
| 6 | **"nlp bounds concurrent inference"**: N+1 concurrent requests → at most N in the model section (instrumented fake classifier); limit resizes on refresh | `apps/nlp/tests/test_inference_semaphore.py` |
| 7 | NLP client: fallback/negative-cache/single-flight (mirror of #3) | `apps/nlp/tests/test_effective_config_client.py` |
| 8 | **"stt consumes model_cache keys via client; GlobalSettingRead gone"**: cache picks up served `ttl_seconds`/`max_models` (clamp still enforced: served 30 → 60); `from stt.core.database import GlobalSettingRead` raises `ImportError`; grep-style assert zero references | `apps/stt/tests/unit/test_effective_config_client.py`, `apps/stt/tests/unit/test_database_exports.py` |
| 9 | Guardrail: profile fields ride the existing cache entry; DB error still → env fallback (existing tests extended, not weakened) | guardrail in-package tests (`apps/guardrail/src/guardrail/tests/`) |

**Gates** (all pasted as evidence): `pnpm --filter @arcaai/applications build test` · `pnpm build:api` + `pnpm test:unit` · `pnpm py:smr:test|lint|typecheck` · `pnpm py:nlp:test` + `py:nlp:lint|typecheck` · `pnpm py:stt:test|lint|typecheck` · `pnpm py:guardrail:test|lint|typecheck` · `pnpm lint`. E2E (route reachable with real tokens) authored here, executed in Phase 7 (TASK-534).

## 6. Acceptance & Definition of Done

- [ ] `GET /api/v1/internal/effective-config?service=<name>` live for the six service names; per-service token auth fail-closed; excluded from Swagger; boot audit passes.
- [ ] SMR/NLP/stt pull clients: 60 s jittered TTL, negative cache, single-flight, env fail-safe — behavior with the gateway down is byte-identical to today's env-driven behavior (program §7 discipline).
- [ ] SMR semaphores resize live without dropping in-flight permits; NLP inference bounded by a live-resizable semaphore.
- [ ] stt `GlobalSettingRead` + re-export deleted; `model_cache`/`workers` values control-plane-driven with clamp intact (D-11, D-07-config-path closed).
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
| **Rollback** | Pure-additive: unset/ignore the gateway route (services negative-cache into env behavior); revert the client wiring commits per service independently; the stt model deletion is trivially revertable (read-only mapping, no migration) |

## 8. References

- Program plan §3 AD-1/AD-2, §4 Phase 1 TASK-525 — `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-program-plan.md`
- Findings §3-E2/E6, D-07, D-11, GAP-C2/L4 — `docs/implementation/SOTA-Track/2026-07-20-agentic-platform-review-findings.md`
- Exemplars: `apps/guardrail/src/guardrail/core/tenant_config.py` (pull cache) · `apps/api/src/modules/consultation/harness-internal.controller.ts` + `harness-service-token.guard.ts` (internal route/auth) · `apps/api/src/modules/internal/stt-internal.controller.ts` (API-key variant) · `apps/smr/src/smr/api/middleware/auth.py` (service-token middleware)
- Key sites: `apps/smr/src/smr/main.py:202-218` · `core/defaults.py:10-23` · `apps/nlp/src/nlp/dependencies.py:98-120` · `apps/stt/src/stt/core/database/models.py:159-178` · `core/config/settings.py:121-145,312,417` · `packages/database/src/prisma/db_main/seed/06-stt.ts:1046-1115`
- Rules: 01 (lifecycle/TDD), 05 (internal routes, boot audit), 06 (Python services, test placement)

## 9. Implementation Summary

**Status: COMPLETE — all steps 4.1–4.6 implemented TDD-first; every static gate green (§9.6).**
Runtime verification (live gateway + services, real tokens) is taken by the owner.

### 9.1 Step 4.1 — gateway route + guard + read service (lane B)

| File | Action |
|---|---|
| `packages/applications/src/services/settings-registry/descriptors/service-runtime.descriptors.ts` | **NEW** — registers `stt.modelCache.{maxModels,ttlSeconds,maxMemoryMb}`, `stt.workers.concurrency`, `stt.streaming.maxConcurrent`, `nlp.inference.maxConcurrent` (see decision **DR-1**) |
| `packages/applications/src/services/settings-registry/registry.ts` | UPDATE — append `SERVICE_RUNTIME_SETTINGS` |
| `packages/applications/src/services/effective-config/IEffectiveConfigService.ts` | **NEW** — the frozen §3.2 contract as types |
| `packages/applications/src/services/effective-config/effective-config.service.ts` | **NEW** — per-service subset resolution + `source` stamping |
| `packages/applications/src/services/effective-config/effective-config.service.module.ts`, `index.ts` | **NEW** — DI module + barrel |
| `packages/applications/src/services/index.ts` | UPDATE — barrel export (append-only) |
| `apps/api/src/modules/internal/internal-service-token.guard.ts` | **NEW** — generalized per-service token guard |
| `apps/api/src/modules/internal/effective-config.controller.ts` | **NEW** — `@Controller('internal/effective-config')` |
| `apps/api/src/modules/internal/internal.module.ts` | UPDATE — register controller + guard + service module |

Tests (RED observed before each implementation): `effective-config.service.test.ts` (13), `internal-service-token.guard.test.ts` (13), `effective-config.controller.test.ts` (6).

### 9.2 Gate evidence (step 4.1)

```
pnpm --filter @arcaai/applications build   → tsc, no output (success)
pnpm --filter @arcaai/applications test    → Test Files 314 passed | 1 skipped (315)
                                             Tests 6506 passed | 4 skipped (6510)     [baseline 6493 → +13]
pnpm build:api                             → Tasks: 8 successful, 8 total (15.6s)
pnpm test:unit                             → Test Files 942 passed | 2 skipped (944)
                                             Tests 16643 passed | 4 skipped | 9 todo (16656)
pnpm --filter @arcaai/api lint             → clean (0 errors)
pnpm --filter @arcaai/applications lint    → 142 warnings (was 158); ZERO in files owned by this ticket
```

RED evidence: `Cannot find module '../effective-config.service'` and `Cannot find module '../internal-service-token.guard'` — both observed failing before implementation.

### 9.3 Decision rows (deviations from the plan, per §Completion & Cleanup Doctrine)

| ID | Deviation | Rationale |
|---|---|---|
| **DR-1** | §4.4 assumed **TASK-524 had registered the `stt.config.*` keys**; it had not (verified: `descriptors/` had six files, none `stt.*`; zero `stt.config` registry hits). This ticket authors `service-runtime.descriptors.ts` instead. | Owner-approved 2026-07-20. Alternative (reading the raw `stt.config` GlobalSetting rows) was rejected — it perpetuates the "two registries drift" risk in program plan §7. Note the legacy seed rows are keyed by the bare `key` column (`max_models`, `concurrency`), so they are **not** addressable by dotted registry keys; they remain untouched (seeds are not this ticket's ownership). |
| **DR-2** | `stt.modelCache.maxMemoryMb` default is **10000, not the seed's 16384**. | The seed row never had a reader (D-11); the running code uses the `10000` ctor fallback (`models/cache.py:101`). Adopting 16384 would silently raise the memory ceiling 64% on first deploy — exactly the D-07 failure mode the §7 risk table forbids. Reconciling/retiring the legacy row belongs to the seed owner. |
| **DR-3** | Guard resolves **`SMR_SERVICE_TOKEN`** for `service=smr` (ticket §3.2 flagged this name "unverified"). | Confirmed: SMR reads `settings.service_token` under the `SMR_` pydantic prefix (`core/config.py:206`), so that is the name it presents. The gateway's *outbound* proxying separately resolves `SMR_SERVICE_TOKEN`; the two are distinct secret names holding the same value by deployment convention. Owner-approved. |
| **DR-4** | Unknown `service` returns **400 only for an authenticated caller**; an unauthenticated one gets 401. | Guards run before controllers, so a pure 400 would make the route an unauthenticated service-name oracle. The guard admits any caller holding a valid service token (controller then answers the contract's 400) and rejects everyone else. Satisfies the §3.2 contract without weakening fail-closed. |
| **DR-5** | `EffectiveSettingsService` exposes **no `db`/`env-fallback` stamp** — it returns `sourceScope: string` with a tier-dependent vocabulary. | Derived in the read service as `sourceScope === 'code-default' ? 'env-fallback' : 'db'` rather than extending the TASK-524-owned facade. |
| **DR-6** | A control-plane read failure **degrades to `env-fallback` + null values** instead of failing the request. | Mirrors §3.1's deterministic-degradation posture on the server side: a cold/broken override lane leaves services on exactly their env behaviour rather than breaking their config pull. Locked by a test. |

### 9.4 Owner acknowledgements obtained

- **New bootstrap env vars** (`SMR_GATEWAY_URL`, `NLP_GATEWAY_URL`) — §3.6 deviation **acked** 2026-07-20. Not yet added (they land with steps 4.2/4.3).

### 9.5 Steps 4.2–4.6 — service adoption

**Re-verified as still true** before implementation: D-11 (`GlobalSettingRead` had exactly two references — the class definition and the `__init__` re-export, zero callers) and GAP-L4 (zero `asyncio.Semaphore` under `apps/nlp/src`).

#### 4.2 SMR (lane E)

| File | Action |
|---|---|
| `apps/smr/src/smr/services/resizable_semaphore.py` | **NEW** — `ResizableSemaphore` (§3.4) |
| `apps/smr/src/smr/core/effective_config.py` | **NEW** — pull client (§3.3) |
| `apps/smr/src/smr/services/runtime_limits.py` | **NEW** — applies snapshot → semaphores + timeouts |
| `apps/smr/src/smr/main.py` | UPDATE — semaphores built as `ResizableSemaphore`; client + `provider_timeouts` on `app.state` |
| `apps/smr/src/smr/core/config.py` | UPDATE — `gateway_url`; module + field docstring deltas (§4.6) |
| `apps/smr/src/smr/core/dependencies.py` | UPDATE — `get_effective_config_client`, `get_runtime_limits` |
| `apps/smr/src/smr/api/endpoints/generate.py` | UPDATE — route dependency drives the refresh |
| `apps/smr/src/smr/api/endpoints/health.py` | UPDATE — `effective_config` diagnostics block (§3.7) |

Tests: `test_resizable_semaphore.py` (15), `test_effective_config_client.py` (20), `test_effective_config_wiring.py` (14).

#### 4.3 NLP (lane E)

| File | Action |
|---|---|
| `apps/nlp/src/nlp/core/concurrency.py` | **NEW** — mirrored `ResizableSemaphore` + module singleton + `refresh_inference_limit` |
| `apps/nlp/src/nlp/core/effective_config.py` | **NEW** — pull client (mirror) |
| `apps/nlp/src/nlp/core/config.py` | UPDATE — `gateway_url`, `inference_max_concurrent` (both annotated) |
| `apps/nlp/src/nlp/dependencies.py` | UPDATE — `get_inference_bound` route dependency |
| `apps/nlp/src/nlp/api/v1/rest/{classify,diagnosis}.py` | UPDATE — the 3 REST inference calls bounded |
| `apps/nlp/src/nlp/api/v1/ws/classify.py` | UPDATE — `_bounded()` wraps the 2 streaming `process` callables |
| `apps/nlp/src/nlp/{lifespan.py,api/v1/rest/monitoring.py}` | UPDATE — client wiring + health block |

Tests: `test_inference_semaphore.py` (12), `test_effective_config_client.py` (9).

#### 4.4 stt (lane D)

| File | Action |
|---|---|
| `apps/stt/src/stt/core/effective_config.py` | **NEW** — pull client reusing `api_gateway_url`/`api_gateway_key` |
| `apps/stt/src/stt/core/runtime_limits.py` | **NEW** — retention/worker/streaming resolution |
| `apps/stt/src/stt/core/database/{models.py,__init__.py}` | UPDATE — **`GlobalSettingRead` DELETED** (D-11) + re-export dropped |
| `apps/stt/src/stt/models/cache.py` | UPDATE — `apply_retention()` (clamp re-applied), injectable refresher |
| `apps/stt/src/stt/main.py` | UPDATE — installs the refresher at startup |
| `apps/stt/src/stt/worker.py` | UPDATE — worker-thread ceiling from the control plane (see **DR-7**) |
| `apps/stt/src/stt/streaming/_runtime.py` | UPDATE — streaming ceiling applied after hardware detection |
| `apps/stt/src/stt/core/config/settings.py` | UPDATE — docstring deltas (§4.6) |
| `apps/stt/src/stt/health/api/routes.py` | UPDATE — health block |

Tests: `test_effective_config_client.py` (14, incl. the clamp cases), `test_database_exports.py` (7).

#### 4.5 Guardrail (lane E, small)

`apps/guardrail/src/guardrail/core/tenant_config.py` — `AiRuntimeProfileRead` mapping + `_load_runtime_profile()` folded into the existing cache entry (no extra TTL window); `resolve_guardian_engine` applies `temperature`/`max_tokens`/`timeout_s` via the existing `model_copy` path, now **independently of** the model override. Transport unchanged (AD-1); `local_path` deferred (D-12 → TASK-527). Tests: `test_tenant_config_runtime_profile.py` (9); the 31 existing `test_tenant_config.py` tests were extended-around, not weakened.

#### 4.6 Docstrings + env deltas

Field-level "bootstrap fallback — runtime value comes from the control plane" annotations on every adopted pydantic field (SMR's six provider configs, NLP's two new fields, stt's `model_cache_*` / `streaming_max_concurrent`); module-docstring notes on `smr/core/config.py` and `guardrail/core/tenant_config.py`. The two acked bootstrap vars added to `turbo.json#globalEnv` + `.env.example` + `.env.dev`, each with a comment stating they are transport, not authority. `uv.lock` untouched (no new dependencies — `httpx` and `structlog` were already present everywhere).

### 9.6 Gate evidence (final, full sweep)

```
# TypeScript
pnpm --filter @arcaai/applications build   → tsc, clean
pnpm build:api                             → Tasks: 8 successful, 8 total (14.9s)
pnpm test:unit                             → Test Files 942 passed | 2 skipped (944)
                                             Tests 16643 passed | 4 skipped | 9 todo (16656)
pnpm --filter @arcaai/api lint             → clean (0 errors)
pnpm --filter @arcaai/applications lint    → 142 warnings (baseline 158); ZERO in files owned by this ticket

# Python — tests
apps/smr        → 923 passed, 32 deselected
apps/nlp        → 141 passed
apps/stt     → 2397 passed, 1 skipped   (unit)
apps/guardrail  → 137 passed

# Python — lint (ruff) + typecheck (mypy)
py:smr:lint|typecheck     → All checks passed / Success: no issues found in 51 source files
py:nlp:lint|typecheck        → All checks passed / Success: no issues found in 43 source files
py:stt:lint|typecheck     → All checks passed / Success: no issues found in 121 source files
py:guardrail:lint|typecheck  → All checks passed / Success: no issues found in 29 source files
```

RED evidence observed before each implementation: `Cannot find module '../effective-config.service'` · `'../internal-service-token.guard'` · `No module named 'smr.services.resizable_semaphore'` · `'smr.core.effective_config'` · `'smr.services.runtime_limits'` · `'nlp.core.concurrency'` (+ client) · `'stt.core.effective_config'` · 6 failing guardrail profile assertions.

### 9.7 Bugs the tests caught during implementation (kept, not papered over)

1. **`or {}` on an empty dict** (`smr/services/runtime_limits.py`) — `provider_timeouts={}` is falsy, so `or {}` substituted a throwaway dict and the first timeout override never reached `app.state`. An empty dict is the NORMAL initial state, so this would have silently disabled timeout overrides in production. Replaced with an `isinstance` narrowing that preserves identity.
2. **Flaky diagnostics assertion** (mine, in both the SMR and NLP client tests) — `assert "9" not in str(diag)` also matches digits inside the ISO `last_refresh_at` timestamp. It passed in isolation only because that run's timestamp happened to lack a `9`, and failed in the full suite. Replaced with an exact key-set assertion, which is what actually pins the "labels and timestamps only" contract.
3. **`__init__` truncation** (`stt/models/cache.py`) — an insertion landed mid-`__init__`, orphaning the stats counters and loader table (`AttributeError: no attribute '_misses'` across 26 existing tests). Methods moved after `__init__`.
4. **Model cache took a hard HTTP dependency** — the first cut called the pull client directly from `get_or_load`, making 26 unit tests attempt real network I/O. Replaced with an injectable refresher that is UNSET by default and installed at app startup, so the cache never hard-depends on HTTP.

### 9.8 Decision rows added during service adoption

| ID | Deviation | Rationale |
|---|---|---|
| **DR-7** | stt's control-plane worker ceiling feeds **`settings.worker_threads`, not `settings.worker_concurrency`**. | `worker_concurrency` is documented as an "alias" but has **zero read sites** anywhere in the service (verified by grep over `apps/stt/src`); `worker_threads` is what actually reaches `Worker(...)` in `worker.py`. Wiring the control plane to the alias would have produced an admin knob that silently does nothing — the exact D-07 failure class. The alias's field description now says so explicitly. **SUPERSEDED BY DR-12 — see §9.10: the `worker.py` path this row describes is itself dead in the shipped image.** |
| **DR-8** | `ResizableSemaphore` admits capacity by comparing `in_flight` against the **current limit** on each acquire, rather than the "shrink deficit" bookkeeping described in §3.4. | Same guarantees with less state, and it fixes a case the deficit design gets wrong: shrinking while idle. With a deficit counter the already-free permits stay claimable, so a shrink from 4→2 with nothing in flight would still admit 4. Locked by `test_shrink_with_idle_capacity_takes_effect_immediately`. |
| **DR-9** | The SMR/NLP/stt refresh is driven by a **route/DI dependency**, not a background poller. | Matches §3.3's "read-triggered, not a background task": no new lifecycle, and a service that never serves never polls. Cost inside the TTL window is a dict lookup. |
| **DR-10** | stt's ModelCache refresher is **injected at app startup** rather than imported directly by the cache. | Keeps the cache free of a hard HTTP dependency so unit tests and non-served contexts do zero network I/O (see §9.7 item 4). |
| **DR-11** | Guardrail applies profile tuning **even when no model override is present**. | The original early-return skipped tuning whenever `model` was unset, which would have made `temperature`/`timeout` silently inert for any provider still on its env model. |

## 9.10 Concurrency audit + DR-7 correction (post-review)

Prompted by the owner's question — *"does any implemented logic indicate it can handle requests in parallel, especially for realtime transcription?"* — the stt concurrency story was audited end-to-end rather than assumed. Findings, with verdicts:

| Ceiling | Verdict | Evidence |
|---|---|---|
| **Realtime streaming** `max_concurrent_streams` | **ENFORCED — was already correct** | `CapacityGuard` (`streaming/capacity_guard.py:49-74`) is an `asyncio.Lock`-protected admission gate. `SessionManager.create_session` calls `try_acquire` *first* (`session_manager.py:795`), returns `None` when full, and the route turns that into **HTTP 503 + `Retry-After: 5`** (`streaming/api/routes.py:101-107`). Release is symmetric (`:1038-1046`) with a periodic orphan-slot reconciler (`:3386-3395`). Covered by real tests incl. a 6th-session rejection through the live path (`tests/unit/test_streaming.py:1293-1309`). **This ticket's control-plane override lands in `_runtime.py` BEFORE `SessionManager` construction, so the served value becomes the guard's real ceiling.** |
| **Realtime hot path** (parallelism quality) | **Best practice followed** | Every ASR backend is offloaded off the event loop via `asyncio.to_thread` — Transformers `:1680`, faster-whisper `:1577`, NeMo `:1456`, parakeet.cpp `:1513`, whisper.cpp `:1538`, Azure `:1835`, Sortformer diarization `inference.py:898`. The C/C++ engines (CTranslate2, whisper.cpp, parakeet.cpp) and PyTorch kernels release the GIL during decode, so audio ingestion and inference genuinely overlap. |
| **Batch worker** `worker_threads` | **WAS NOT ENFORCED — defect found in this ticket's own 4.4 work; now fixed** | See DR-12. |
| `batch_scheduler_max_wait_ms` | **NOT ENFORCED (pre-existing, out of scope)** | Set per hardware tier and reported at `session_manager.py:3416`, but **no `BatchScheduler` implementation exists** — zero read sites. Dead configuration, unrelated to this ticket. Logged for the owner (§9.9). |

| ID | Correction | Rationale |
|---|---|---|
| **DR-12** | **DR-7's original wiring was dead code in production, and is replaced by an in-actor gate.** New `apps/stt/src/stt/core/job_concurrency.py` (`ResizableThreadGate`) acquired inside the `transcribe_file` actor. | The shipped image runs `python3.11 -m dramatiq stt.worker --processes 2 --threads 4` (`apps/stt/docker/Dockerfile:242`). The dramatiq CLI **imports** the module (`importlib.import_module`) rather than executing it as `__main__`, then builds its own `Worker` from its own `--threads` flag — so `worker.py:main()` never runs and the value DR-7 fed into it reached nothing. That is the identical "wiring a dead field" failure (D-07) this ticket exists to close, committed by this ticket. The gate binds inside the actor, so it holds under **any** launch mode: dramatiq CLI, `worker.py:main()`, or a direct test call. `worker.py:main()` keeps its wiring for the non-CLI path. |

**Scope of the gate (documented, not hidden):** `--threads` remains the OUTER bound (how many jobs a process can attempt); the gate is the INNER, operator-adjustable bound, so setting it above `--threads` has no effect. It is **per-process** — `--processes N` gives N independent gates, so the fleet ceiling is `N x limit`, the same caveat the streaming `CapacityGuard` carries. A fleet-wide bound needs a shared Redis counter and belongs with TASK-529. A test asserts the docstring states this, so the caveat cannot be quietly dropped.

Tests: `apps/stt/tests/unit/test_job_concurrency.py` (12) — real threads, asserts the ceiling is saturated but never exceeded, that throttling never drops a job, that a failing job releases its slot, that a shrink never revokes a running transcription, and that an idle shrink binds immediately.

## 9.11 Seed convergence (owner-requested, done in this ticket)

The legacy `stt.config` GlobalSetting rows this ticket supersedes are now **deleted** rather than left as a dormant second config lane (Completion & Cleanup Doctrine §2.5):

- **Removed (6 rows)** from `DEFAULT_STT_SETTINGS` (`seed/06-stt.ts`): `model_cache.{max_models,ttl_seconds,max_memory_mb}` and `workers.{concurrency,batch_queue,streaming_queue}`. The first four are replaced by the registered keys `stt.modelCache.*` / `stt.workers.concurrency`; `batch_queue`/`streaming_queue` get **no** replacement because they had no consumer either — the queue names are hardcoded (`stt_batch`, `default`) in `worker.py` and the actor's `queue_name`.
- **The DR-2 divergence is resolved by the deletion**: the seed's `max_memory_mb: 16384` is gone, and the descriptor's `10000` (the value actually in force via the `models/cache.py` ctor fallback) is now the single source of truth. No behaviour change on deploy.
- **Seed tests updated to lock the removal** (`packages/database/src/__tests__/seed.test.ts`): the two "should include …" assertions became "should NOT carry …", so re-introducing a dormant lane fails the suite. `pnpm --filter @arcaai/database test` → 819 passed.
- **Deliberately NOT removed**: the `storage` / `api_gateway` / `defaults` rows in the same array. They are equally unread as GlobalSetting rows (stt's only reader was `GlobalSettingRead`, now deleted) — their values are duplicated in pydantic settings fields such as `minio_audio_bucket` — but this ticket provides **no replacement lane** for them, so deleting them would be removal without convergence. Recorded in §9.9 with the evidence.

### 9.9 Residual items for the owner / follow-up tickets

- **Runtime verification** (owner-taken): live gateway + each service with real tokens, end-to-end pull, and a live semaphore resize under load.
- ~~Legacy `stt.config.*` GlobalSetting rows~~ — **DONE in this ticket at the owner's request; see §9.11.** The 6 superseded rows are deleted and the removal is locked by tests.
- **Remaining unread `stt.config` rows** (`storage`, `api_gateway`, `defaults` groups in `DEFAULT_STT_SETTINGS`): also never read (stt's only GlobalSetting reader is gone), with their values duplicated in pydantic settings fields (e.g. `minio_audio_bucket`). Left in place because this ticket offers no replacement lane for them — deleting them would be removal without convergence. Candidate for TASK-529.
- **`batch_scheduler_max_wait_ms` is dead configuration** (pre-existing, unrelated to this ticket): set per hardware tier in `ExecutionProfile` and reported at `session_manager.py:3416`, but no `BatchScheduler` implementation exists anywhere in `apps/stt/src`. Either implement cross-session batching or retire the field.
- **Fleet-wide concurrency**: both the streaming `CapacityGuard` and the new batch gate are **per-process**. Today's k3s base runs `replicas: 1` for each, so the per-process ceiling *is* the fleet ceiling — but raising replicas without a shared (Redis) counter would let each pod admit its own full quota. Worth deciding before scaling out.
- **`uv lock`** untouched — no Python dependency was added.
- Shared-package extraction of the three mirrored clients + `ResizableSemaphore` remains **TASK-529 OD-3** (deliberately not preempted, per §3.3).

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored (execution-ready): code-verified current state, frozen endpoint contract, semaphore-resize design, ordered per-service plan, RED-first TDD list, env-var deviation flagged (SMR/NLP gateway URL vars). Status Pending — awaiting owner approval + TASK-524. |
| 2026-07-20 | **Post-review concurrency audit + seed convergence** (§9.10–9.11), both owner-prompted. Audit verdict: realtime streaming concurrency was ALREADY correctly enforced (`CapacityGuard` admission control → HTTP 503 + `Retry-After`, inference offloaded off the event loop via `asyncio.to_thread` on every backend), and this ticket's control-plane override correctly feeds that guard. But **DR-7's own batch-worker wiring was found to be dead code in the shipped image** — the Dockerfile runs the dramatiq CLI, which imports `stt.worker` instead of executing `main()` — i.e. this ticket had itself committed the D-07 failure it exists to close. Corrected by **DR-12**: a new in-actor `ResizableThreadGate` (`core/job_concurrency.py`, 12 tests) that binds under any launch mode, with its per-process scope documented and test-locked. Seeds: the 6 superseded `stt.config` rows deleted and the removal locked by updated seed tests (§9.11), which also resolves the DR-2 `max_memory_mb` divergence. |
| 2026-07-20 | **Steps 4.2–4.6 implemented TDD-first and gated** (§9.5–9.6): SMR `ResizableSemaphore` + pull client + live resize wiring; NLP's first-ever inference bound (GAP-L4) across all 5 inference entry points incl. the two streaming callables; stt pull client, **`GlobalSettingRead` deleted** (D-11), model-cache retention adoption with the clamp double-enforced, and worker/streaming ceilings; guardrail's SQL resolver extended with `AiRuntimeProfile` tuning; docstring + env deltas. Five further decision rows DR-7…DR-11 (§9.8) — notably **DR-7**: stt's `worker_concurrency` has ZERO read sites, so the control plane feeds the real `worker_threads` field instead of the dead alias. Four bugs the tests caught are recorded in §9.7. Status → Review. |
| 2026-07-20 | **Step 4.1 implemented TDD-first and gated** (§9.1–9.2): internal `GET /api/v1/internal/effective-config` route, generalized `InternalServiceTokenGuard`, `EffectiveConfigService` read service, and the `service-runtime` settings descriptors. Six deviations recorded as decision rows DR-1…DR-6 (§9.3) — most consequentially **DR-1**: TASK-524 never registered the `stt.config.*` keys this ticket's §4.4 assumed it would, so the descriptors are authored here (owner-approved), and **DR-2**: the descriptor default deliberately keeps the code's 10000 rather than the seed's divergent 16384. Status remains Pending — steps 4.2–4.6 (all Python lanes) not started. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
