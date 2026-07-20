# TASK-528 — LM Studio/Ollama Model Discovery & the AI-Models Hub

- **Status**: Pending
- **Type**: feature
- **Program**: Phase 2 of the [Agentic Platform Program Plan (2026-07-20)](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §4 / frozen contract **AD-5**; closes **GAP-C4** and part of **M-04** from the [companion findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) §6/§7
- **Numbering**: TASK-528 is the program plan's *suggested* number — confirm against `docs/implementation/` + `docs/archive/` highest-number rule (CLAUDE.md ticket workflow) at open time
- **Size**: M · **Lanes**: B (apps/api) + C (admin-console) + E (apps/smr)
- **Dependencies**: TASK-523 (P0 defect clearance — starts only after the owner commits the current ~330-file tree, plan §2.3/OD-7). **Independent of TASK-524**: this ticket uses only the existing `AiModel` table — verified in §2.6 below, no new tables/migrations, no `AiProviderConnection`/`AiRuntimeProfile` reads.
- **Design-gate precondition (rule 12)**: the registry screen exists as Figma frame `15 - AI Model Registry` (referenced in `ai-models-screen.tsx:55`). The discovery drawer + register flow + unhidden nav entry require either an updated/approved frame or an explicitly recorded owner waiver in this README **before** console implementation starts (the TASK-512-wave waiver precedent).

---

## 1. Requirement Analysis

Owner expectation **E5** (findings §0, verbatim intent): *"lmstudio/ollama → server-managed, system fetches registered models, global admin controls hyperparameters/context/concurrency"*. The bolded clause for this ticket: **the system must fetch and return the models registered on the server** — as a **first-class global-admin surface**, not the current empty-registry-only fallback.

Requirement IDs:

| ID | Requirement | Source |
|---|---|---|
| R1 | `GET admin/ai-models/discovery?provider=` (global-admin) merges DB `AiModel` rows with the **live** engine listing, tagging each entry `registered` \| `discovered` \| `registered-missing-on-server`, plus load state where the engine reports it | AD-5 |
| R2 | `POST admin/ai-models/discovery/register` creates an `AiModel` row from a discovered entry (slug/name/provider/format prefilled; OCC-free create; factory + sys-event per house rules) | AD-5 |
| R3 | SMR probe hardening: per-provider timeout + partial-failure response shape on `GET /providers` — one down/hung provider must not stall or 500 the endpoint | ticket scope (b) |
| R4 | Investigate LM Studio's richer native REST (`/api/v0/models`: load state, quantization, max context) — reachable from the current client? Worth `engine_native`-style metadata? (optional enhancement if `/v1/models` suffices) | ticket scope (b) |
| R5 | Console: unhide `/ai-models`; upgrade the feature into the provider/model hub — registry grid + discovery drawer (badges per tag + load state) + register action; ai-task-defaults platform screen links "Manage models" to the hub | ticket scope (c), M-04 |
| R6 | Registry stays authoritative for task routing (`AiTaskDefault` picker unchanged); discovery is an operator affordance; register is **explicit** — no auto-sync | AD-5, §3.2 |

Out of scope (owned elsewhere): hyperparameters/context/concurrency admin (TASK-524 `AiRuntimeProfile`), model **download** orchestration (TASK-527's `resolve_model_dir`), retention/`keep_alive` (TASK-529), `/ai-model-defaults` tenant screen rebuild (TASK-526/532).

## 2. Current State Evaluation (code-verified 2026-07-20; working tree on `fix/2605-review`)

### 2.1 The fallback-only mechanics this ticket supersedes for admin use

`apps/api/src/modules/streaming/smr-proxy.controller.ts:922-981` — `GET text/providers` reads ENABLED `TEXT_GENERATION`/`SUMMARIZATION` `AiModel` rows and returns them grouped by provider; the live SMR probe fires **only when the registry has zero rows** (comment at `:926-927`: "survives ONLY as transition safety"). Consequence (findings E5): a model registered on the Ollama/LM Studio server but absent from `AiModel` is invisible through the primary path. `GET text/guardrail-providers` (`:987+`) deliberately has **no** live probe ("no upstream-service probe: an empty result simply means not configured" `:985-986`) — correct fail-configured posture, stays unchanged. The only UI reaching the live-fallback path is the Playground (tier 50-59), not any governing screen. Downstream URL correctly comes from `IConfigService.getConfigValue('SMR_URL')` (`getSmrBaseUrl()`, `:187-189`).

**Supersede decision** (see §3.4): `text/providers` keeps its transition fallback for the Playground; the admin hub uses the new discovery route. Its `:922-927` comment gains a pointer to the discovery surface.

### 2.2 SMR probe implementations (per provider)

- Endpoint: `apps/smr/src/smr_v2/api/endpoints/providers.py:16-25` — **sequential** `for` loop over `registry.list_providers()`, awaiting `provider.get_info()` one by one. No per-provider timeout, no error/latency detail in the response.
- Ollama: `apps/smr/src/smr_v2/providers/ollama.py:195-213` — `GET {base_url}/api/tags` on the **shared** httpx client, whose timeout is `httpx.Timeout(300.0)` (`main.py:110`). Exceptions caught → `status: "unavailable"`, so a *down* provider doesn't 500 — but a *hung* one blocks the whole endpoint for up to 300 s. Load state (`/api/ps`) is never queried.
- LM Studio / vLLM (OpenAI-compat): `apps/smr/src/smr_v2/providers/openai_compat.py:229-246` — `await self._client.models.list()` on an `AsyncOpenAI` client constructed with `timeout=float(config.timeout_s)` = **300 s** default (`core/config.py:72` — the generation timeout reused for a listing probe) and a bare `except Exception: pass` (`:237-238`) that swallows all diagnostics.
- `ProviderInfo`/`ModelInfo` (`apps/smr/src/smr_v2/models/provider.py:8-20`): `name`, `display_name`, `status: str`, `default_model`, `models[{name, supports_streaming, context_window}]` — no probe-error field, no latency, no per-model load state.
- **Provider naming** (findings note, verified `main.py:61-67`): the registry keys are **`lm-studio`** (product key) and `openai_compat` (alias to the same shared instance). `lmstudio` is **not** a registered alias — the gateway and console must use `lm-studio` exactly. `azure-openai`/`azure`, `ollama`, `bedrock`, `vllm`, `llama-cpp` complete the key set.

### 2.3 What load-state data each engine exposes today

| Engine | Listing used today | Load state available? |
|---|---|---|
| Ollama | `GET /api/tags` (downloaded models; no state) | **Yes** — `GET /api/ps` lists *running* models incl. `expires_at`, `size_vram`. Not called anywhere today. |
| LM Studio via `/v1/models` (OpenAI-compat) | all downloaded models | **No** — the OpenAI-compat listing carries no state. |
| LM Studio native REST `GET /api/v0/models` | not called anywhere | **Yes** — per-model `state` (`loaded`/`not-loaded`), `quantization`, `max_context_length`, `arch`, `publisher` (LM Studio REST API, beta). |
| vLLM / llama.cpp server | `/v1/models` | n/a — single resident model by design; "listed ⇒ loaded". |

**R4 investigation result**: the native LM Studio REST **is reachable** from the current client topology — `OpenAICompatConfig.base_url` defaults to `http://localhost:1234/v1` (`config.py:69`); the native API lives on the same host at `/api/v0/*`, so a plain `httpx` GET (the shared `app.state.http_client` already exists) against `base_url` with the trailing `/v1` stripped reaches it. The `AsyncOpenAI` client itself cannot (it prefixes `/v1` paths). Since `/v1/models` does **not** suffice for load state, this is a **recommended optional enhancement** (§3.3): implemented behind a graceful fallback — native probe failure degrades to the `/v1/models` result with `load_state: unknown`, never fails the listing. It stays optional in the sense that the merge view is fully functional without it (LM Studio entries show `unknown` load state).

### 2.4 Existing gateway CRUD + guards

`apps/api/src/modules/ai-model/ai-model-admin.controller.ts` — class-level `@Authorize(['manage', 'all'])` (`:23`, TASK-419 global-admin pin), `@Controller('admin/ai-models')` (`:22`); POST create (`:32`), GET all/list/:id/slug/:slug, OCC PATCH with `@RequiresIfMatch()` + `@ExpectedVersion()` (`:86-118`), DELETE (`:128`). Module: `ai-model.module.ts` (same folder, with `__tests__/`). The discovery routes join this controller family with the identical guard.

### 2.5 Service create path (house-rule compliance already built)

`packages/applications/src/services/stt/model/aiModel.service.ts` — `create()` (`:34-75`): slug-uniqueness precheck via `aiModelRepository.isSlugUnique(tenantId, dto.slug)` (`:43`) → `BadRequestException` "already exists" (`:45`, HTTP 400) → `AiModelFactory.CreateAiModel({...})` (`:48`) → `broadcastSysEvent(SysEventType.ResourceCreated, ...)` (`:70`). R2's register action **delegates to this method** — factory, sys-event, and collision behavior are inherited, not re-implemented.

**Drift found (must fix in this ticket)**: the DTO-layer provider allow-list `AI_MODEL_PROVIDERS` in `packages/applications/src/services/stt/model/dto/create-model.request.ts:6` has **6** entries (`ollama, lm-studio, azure, bedrock, built-in, sarvam`) while the seed's canonical list `packages/database/src/prisma/db_main/seed/ai-models/shared.ts:73-85` has **8** (adds `vllm`, `llama-cpp`). Registering a discovered vLLM/llama.cpp model would 400 today at `@IsIn(AI_MODEL_PROVIDERS)` (`create-model.request.ts:104`, mirrored `update-model.request.ts:98`).

### 2.6 AiModel row sufficiency (⇒ independence from TASK-524)

`packages/database/src/prisma/db_main/stt.prisma:101-168`: `name`/`slug` (`:111-112`), `provider String?` (`:130`), `category`/`taskType`/`modelType` (`:116-118`), `source`/`sourceUri` (`:121-122`), `format` (`:126`), `@@unique([tenantId, slug], name: "AiModel_tenant_slug_unique")` (`:159`). Everything a discovered entry needs prefilled exists; no schema change. **Confirmed: this ticket has zero dependency on TASK-524's new tables** — hyperparameter/connection data is explicitly out of scope (R6/AD-1).

### 2.7 Console current state

- Nav: `apps/admin-console/src/shared/navigation/nav-config.ts:123-125` — `/ai-models` entry `implemented: false` with the 2026-07-04 hide comment ("route stays reachable by direct URL"). Tests asserting the hidden state: `src/shared/navigation/__tests__/nav-config.test.ts:42-56` (dedicated hidden-entry spec + `byTier('10-19')` unimplemented list), `:117` (`not.toContain('/ai-models')`), `:140-142` (filter spec).
- The feature is **already a full registry screen**, not a stub: `src/features/ai-models/` — `api/{client,hooks,keys,types}.ts` (full CRUD against `admin/ai-models`, OCC via `patchWithEtag`, `client.ts:32-34`), `components/ai-models-screen.tsx` (server-driven `AdminDataGrid` with omni search/filters/pager, `ScreenTemplate` composition, register/edit sheet, delete confirm — "Frame 15" comment `:55`), `components/model-form-sheet.tsx`, route `src/app/(console)/(global)/ai-models/{page,loading}.tsx` (loading skeleton mirrors the grid per rule 10). So R5's "upgrade" = **add the discovery drawer + register action + unhide**, not build a screen.
- Pre-existing deviation noted (rule 11 §Detail Surface): `model-form-sheet.tsx` hand-rolls a `Sheet` rather than `DetailDrawer`. Out of scope to migrate (Karpathy §3 — surgical changes); the **new** discovery drawer uses `DetailDrawer` (`src/shared/detail/detail-drawer.tsx`, verified present).
- `ai-task-defaults-platform-screen.tsx` (`src/features/ai-task-defaults/components/`) uses `PageHeader` inside `ScreenTemplate` (`:19-20`) — no models link today; R5 adds one.

## 3. Architecture, Patterns & Best Practices

### 3.1 Merge-view design

`GET admin/ai-models/discovery?provider=<optional filter>` returns:

```ts
{
  entries: Array<{
    provider: string;              // registry key, e.g. 'lm-studio' (§2.2 naming note)
    modelName: string;             // server-side name, e.g. 'llama3.1:8b-instruct-q4_K_M'
    status: 'registered' | 'discovered' | 'registered-missing-on-server';
    loadState: 'loaded' | 'not-loaded' | 'unknown';
    registeredModel?: { id: string; slug: string; resourceStatus: string }; // when status != 'discovered'
    engineMeta?: Record<string, unknown>;  // optional native metadata (quantization, max_context_length…)
  }>;
  probes: Array<{ provider: string; probeStatus: 'ok' | 'timeout' | 'error' | 'skipped'; latencyMs?: number; error?: string }>;
  probedAt: string; // ISO — feeds the console staleness indicator
}
```

Merge rule: DB rows (ENABLED + DISABLED, caller tenant via `getAllForAdmin()` semantics, filtered to server-managed providers `ollama`/`lm-studio`/`vllm`/`llama-cpp`) ⋈ live listing, keyed on `(provider, modelName)` — a registered row matches a live entry when its `sourceUri` **or** `slug` equals the server model name (both matchers, documented; `sourceUri` is the canonical carrier of the server-side name for these providers). Unmatched live → `discovered`; unmatched DB → `registered-missing-on-server`; when the provider's probe is not `ok`, its DB rows degrade to `registered` + `loadState: 'unknown'` (never falsely "missing").

### 3.2 Registry authoritative; discovery is an operator affordance; register is explicit

Task routing (`AiTaskDefault` → `AiModel`) reads **only** the DB registry — unchanged. Discovery never mutates rows; there is **no auto-sync** by design (drift safety): a transient probe miss must not disable/delete registry rows, and a server-side experiment must not silently enter governance. The only path from `discovered` → `registered` is the explicit global-admin `POST .../discovery/register`, which is an audited, sys-evented, factory-built create (§2.5). `registered-missing-on-server` is a *warning tag*, not a state transition.

### 3.3 Probe timeout / partial-failure contract (R3, frozen for the SMR lane)

- `GET /providers` gains `asyncio.gather` over providers with `asyncio.wait_for(provider.get_info(), timeout=probe_timeout_s)` — new `SMR_V2_PROVIDER_PROBE_TIMEOUT_S` setting, **default 5 s** (bootstrap env per plan §2.3; joins the TASK-524/525 control plane later, not here). One hung provider ⇒ its entry reports `probe_status: "timeout"`; the endpoint returns 200 with the other providers intact — never 500, never 300 s.
- `ProviderInfo` gains additive optional fields `probe_status`, `probe_latency_ms`, `probe_error`; `ModelInfo` gains `state: str | None` and `engine_native: dict | None`. Additive-only ⇒ the gateway fallback mapper (`smr-proxy.controller.ts:970-973`) and `tests/contracts/smr.contract.test.ts` stay compatible (contract test extended, not rewritten).
- Ollama `get_info` additionally probes `GET /api/ps` (same timeout envelope) to mark `state: "loaded"` on running models; `openai_compat.get_info` replaces `except Exception: pass` with logged, classified handling (mirror `health_check` `:222-227`).
- **Optional enhancement (R4, recommended — small)**: LM Studio native `GET {root}/api/v0/models` (root = `base_url` minus trailing `/v1`) via the shared httpx client fills `state`/`engine_native` (`quantization`, `max_context_length`); any failure degrades silently to the `/v1/models` result. Applied only when `provider_name == "lm-studio"`.

### 3.4 Gateway placement + the superseded fallback

Discovery lives in the existing module: NEW `ai-model-discovery.controller.ts` under `apps/api/src/modules/ai-model/` (`@Controller('admin/ai-models')`, `@Authorize(['manage','all'])` matching `ai-model-admin.controller.ts:23`) + a module-local `ai-model-discovery.service.ts` (precedent: `smr-proxy.controller.ts` does gateway-side HTTP; rule 05 keeps controllers thin, so the HTTP+merge logic sits in the module service, which injects `HttpService`, `IConfigService` (`SMR_URL` — env reads are lint-banned in modules), and `AiModelService`). `text/providers` keeps its empty-registry fallback **for the Playground only** (documented in its comment); the admin hub never calls it. `guardrail-providers` keeps no live fallback (correct — fail-configured), re-documented in the same comment sweep.

Slug generation for register: normalize `modelName` → kebab-case slug (lowercase; `:` `/` `.` `_` → `-`; collapse repeats; trim; ≤ 100 chars), then collision-check against `@@unique([tenantId, slug])` via the service's existing `isSlugUnique` precheck — on collision the register DTO's optional explicit `slug` is required (409-style 400 with actionable message listing the taken slug), no silent suffixing (drift safety: admins name governance rows deliberately).

### 3.5 Provider validation

The register DTO validates `provider` with `@IsIn(AI_MODEL_PROVIDERS)`; the DTO list (`create-model.request.ts:6`) is **aligned to the canonical 8-entry seed list** (`shared.ts:73-85`, adds `vllm`/`llama-cpp`) and a contracts test pins the two lists together (§5). Register additionally restricts to the server-managed subset (`ollama`, `lm-studio`, `vllm`, `llama-cpp`) — cloud providers have nothing to "discover".

### 3.6 Stated assumptions (surface, don't bury)

- The SMR service is the single probe aggregator — the gateway never probes engines directly (keeps `X-Service-Token` topology and engine URLs inside SMR's config, matching the existing `text/providers` fallback path).
- Discovery covers SMR-fronted LLM engines only; STT/TTS engine discovery is out of scope (different services, no owner requirement).
- `vllm`/`llama-cpp` are included in the merge view (they register in the same SMR provider registry and are server-managed) even though E5 names only lmstudio/ollama — listed ⇒ loaded for these single-model servers (§2.3). Flagged for reviewer confirmation; trivially excludable via the §3.5 subset constant.

## 4. Implementation Plan (ordered)

**Order**: SMR probe hardening → gateway discovery routes → console hub (each stage's tests RED-first, per stage gates).

### 4.0 Stage sequence (goal-driven, each with its verify)

1. **SMR probe hardening** (files 1–6) → verify: §5.1 tests GREEN; `pnpm py:smr-v2:test|lint|typecheck` clean; manual `curl :8862/api/v1/providers` with one engine stopped returns 200 with `probe_status` populated.
2. **DTO alignment + register DTO** (files 7–9, 15) → verify: applications build+test green; contracts test GREEN (RED first proves the §2.5 drift).
3. **Gateway discovery routes** (files 10–14) → verify: §5.2 tests GREEN; `pnpm build:api && pnpm test:unit`; Swagger shows both routes under `admin-ai-models`; boot-time route audit passes (both routes decorated).
4. **Console hub** (files 16–24) → verify: §5.4 tests GREEN incl. axe/themes; `pnpm --filter @arcaai/admin-console build lint test`; runtime pass via `next-dev-loop` (open drawer against live local Ollama, register a model, watch it appear in the grid without reload).
5. **Docs/env tail** (file 25 + §4.2 comment deltas) → verify: grep sweep for the updated comments; `.env.example` SMR section carries the new var with a "probe listing only" note.

Stages 1–2 are independent and may run in parallel (lanes E vs B); stage 3 depends on both; stage 4 on 3.

### 4.1 File table & exclusive ownership manifest

| # | File | NEW/UPDATE | Change |
|---|---|---|---|
| 1 | `apps/smr/src/smr_v2/models/provider.py` | UPDATE | `ProviderInfo` + `ModelInfo` additive fields (§3.3) |
| 2 | `apps/smr/src/smr_v2/core/config.py` | UPDATE | `provider_probe_timeout_s: int = 5` on the SMR settings (env `SMR_V2_PROVIDER_PROBE_TIMEOUT_S`) |
| 3 | `apps/smr/src/smr_v2/api/endpoints/providers.py` | UPDATE | parallel gather + `wait_for` + probe fields (§3.3) |
| 4 | `apps/smr/src/smr_v2/providers/ollama.py` | UPDATE | `get_info` + `/api/ps` load state |
| 5 | `apps/smr/src/smr_v2/providers/openai_compat.py` | UPDATE | logged error handling; LM Studio native `/api/v0/models` enrichment (R4, guarded) |
| 6 | `apps/smr/src/smr_v2/tests/unit/test_providers_endpoint.py` | NEW | §5 SMR tests |
| 7 | `packages/applications/src/services/stt/model/dto/create-model.request.ts` | UPDATE | `AI_MODEL_PROVIDERS` +`vllm`,`llama-cpp` (§2.5 drift) + comment pointing at seed `shared.ts` |
| 8 | `packages/applications/src/services/stt/model/dto/register-discovered-model.request.ts` | NEW | register DTO (`provider`, `modelName`, optional `slug`/`name`/`description`; class-validator + `@ApiProperty` on every field) |
| 9 | `packages/applications/src/services/stt/model/dto/index.ts` (+ feature barrel) | UPDATE | export new DTO |
| 10 | `apps/api/src/modules/ai-model/ai-model-discovery.service.ts` | NEW | probe fetch (SMR `GET /api/v1/providers` via `SMR_URL`) + merge + register mapping (§3.1/§3.4) |
| 11 | `apps/api/src/modules/ai-model/ai-model-discovery.controller.ts` | NEW | `GET admin/ai-models/discovery` + `POST admin/ai-models/discovery/register`, `@Authorize(['manage','all'])` |
| 12 | `apps/api/src/modules/ai-model/ai-model.module.ts` | UPDATE | register controller + service |
| 13 | `apps/api/src/modules/ai-model/__tests__/ai-model-discovery.controller.test.ts` | NEW | §5 merge/register tests |
| 14 | `apps/api/src/modules/streaming/smr-proxy.controller.ts` | UPDATE | **comments only** (`:922-927` fallback scoped to Playground + pointer to discovery; `guardrail-providers` posture note) |
| 15 | `tests/contracts/ai-model-providers.contract.test.ts` | NEW | DTO list ⊇/= seed list pin (§3.5) |
| 16 | `apps/admin-console/src/shared/navigation/nav-config.ts` | UPDATE | `/ai-models` → `implemented: true`; rewrite `:123-124` comment (hub, TASK-528) |
| 17 | `apps/admin-console/src/shared/navigation/__tests__/nav-config.test.ts` | UPDATE | flip the hidden-entry assertions at `:42-56`, `:117`, `:140-142` |
| 18 | `apps/admin-console/src/features/ai-models/api/{types,client,keys,hooks}.ts` | UPDATE | discovery GET + register POST + query keys + hooks (TanStack Query; `staleTime` ~30 s, `probedAt` surfaced) |
| 19 | `apps/admin-console/src/features/ai-models/api/__tests__/ai-models-api.test.ts` | UPDATE | new client paths |
| 20 | `apps/admin-console/src/features/ai-models/components/discovery-drawer.tsx` | NEW | `DetailDrawer`-based drawer: per-provider probe status, entries with status/load-state badges, Register action, staleness line + Refresh |
| 21 | `apps/admin-console/src/features/ai-models/components/ai-models-screen.tsx` | UPDATE | header "Discover from servers" action opening the drawer |
| 22 | `apps/admin-console/src/features/ai-models/components/__tests__/discovery-drawer.test.tsx` | NEW | §5 console tests |
| 23 | `apps/admin-console/src/features/ai-models/components/__tests__/ai-models-screen.test.tsx` | UPDATE | action button + drawer wiring |
| 24 | `apps/admin-console/src/features/ai-task-defaults/components/ai-task-defaults-platform-screen.tsx` (+ its test) | UPDATE | `PageHeader` "Manage models" link → `/ai-models` |
| 25 | `.env.example` (+ `.env.dev`, `turbo.json#globalEnv` if TS-read — it is not; Python-only, so `.env.example` SMR section only) | UPDATE | document `SMR_V2_PROVIDER_PROBE_TIMEOUT_S` |

No other files. No migrations. Barrel edits append-only (plan §7).

### 4.2 Comment deltas (binding, plan §6)

`smr-proxy.controller.ts:922-927` (fallback now Playground-scoped) · `nav-config.ts:123-124` (hide rationale obsolete) · `create-model.request.ts:6` (canonical-list pointer) · `providers.py` module docstring (probe contract) · `ai-models-screen.tsx:54-59` frame reference updated if the frame number changes at design approval.

### 4.3 Out of scope (explicit)

- ai-task-defaults **picker** behavior unchanged (DB-only; governance unchanged — AD-5).
- `guardrail-providers` fallback posture unchanged (no live probe — correct).
- Model DOWNLOAD orchestration (TASK-527's resolver owns weight paths).
- Hyperparameters/context/concurrency surfaces (TASK-524), retention/`keep_alive` (TASK-529), `model-form-sheet` → `DetailDrawer` migration (pre-existing, noted §2.7).

## 5. TDD Plan (RED first — paste failing runs into this README before implementing)

### 5.1 SMR — `apps/smr/src/smr_v2/tests/unit/test_providers_endpoint.py` (NEW)

1. `test_hung_provider_times_out_without_blocking` — registry stub with one provider whose `get_info` sleeps past the timeout: response 200 within budget; that provider `probe_status == "timeout"`; others `"ok"` with `probe_latency_ms` set.
2. `test_raising_provider_yields_error_not_500` — `get_info` raising → 200, `probe_status == "error"`, `probe_error` populated.
3. `test_ollama_load_state_from_api_ps` — httpx-stubbed `/api/tags` + `/api/ps`: running model gets `state == "loaded"`, others `"not-loaded"`; `/api/ps` failure ⇒ all `state is None`, listing intact.
4. `test_lmstudio_native_enrichment_degrades_gracefully` — native `/api/v0/models` stub returns `state`/`quantization`/`max_context_length` → surfaced in `engine_native`; native 404 ⇒ `/v1/models` result unchanged.
   (Fake clocks / stubbed transports only — hermetic per plan §5.4.)

### 5.2 Gateway — `apps/api/src/modules/ai-model/__tests__/ai-model-discovery.controller.test.ts` (NEW)

1. `merges discovered-not-registered` — live fixture has `mistral:7b`, DB doesn't → `status: 'discovered'`.
2. `merges registered-missing-on-server` — DB row (slug/sourceUri) absent from live fixture → tagged, `registeredModel` populated.
3. `merges registered (both sides) with load state` — match on `sourceUri` and on `slug`; `loadState` passed through.
4. `probe failure degrades DB rows to registered/unknown` — provider probe `timeout` ⇒ no false `registered-missing-on-server`.
5. `register creates via the service` — asserts `AiModelService.create` called with mapped `CreateModelRequest` (factory + `broadcastSysEvent(ResourceCreated)` asserted at the existing service tests; controller test asserts delegation + response DTO shape).
6. `register duplicate slug → 400 with actionable message` (service `isSlugUnique` path; explicit-slug escape hatch covered).
7. `register rejects non-server-managed / unknown provider` — `azure` and `not-a-provider` → 400 (`@IsIn` + subset rule).
8. Guard: route metadata carries `['manage','all']` (mirrors existing controller-test pattern in `apps/api/src/modules/ai-model/__tests__/`).
   Applications: `register-discovered-model.request` validation test colocated with the DTO tests; slug-normalization unit test beside the service util.

### 5.3 Contracts — `tests/contracts/ai-model-providers.contract.test.ts` (NEW)

DTO `AI_MODEL_PROVIDERS` (applications) === seed `AI_MODEL_PROVIDERS` (`shared.ts:73-85`) — pins §2.5's drift closed. Extend `tests/contracts/smr.contract.test.ts` with the additive `ProviderInfo`/`ModelInfo` fields.

### 5.4 Console (Vitest, colocated `__tests__/`)

1. `discovery-drawer.test.tsx` — grid states: loading **skeleton matching the drawer layout** (rule 10), empty ("no servers reachable" via `Empty` family), error state; badge per tag (`registered` outline / `discovered` secondary / `registered-missing-on-server` destructive-ish per rule 11 §7) + load-state badge; per-provider probe-status line; staleness indicator renders `probedAt`.
2. `register flow` — click Register → mutation fired → optimistic/invalidate updates both the drawer entry (→ `registered`) and the registry grid query key; failure → `toast.error`.
3. `ai-models-screen.test.tsx` — header action opens drawer; existing grid specs stay green.
4. `nav-config.test.ts` — flipped assertions (`/ai-models` now implemented; hidden-entry spec at `:42-56` inverted/removed; `:117`/`:140` updated).
5. `ai-task-defaults` platform screen test — "Manage models" link present, href `/ai-models`.
6. **axe: 0 violations** on the screen incl. open drawer; **both themes** verified (rule 11 §11 + 13 DoD). Manual keyboard + 200 %-zoom pass per the `web-accessibility` skill.

### 5.5 Gate commands (per stage)

`pnpm py:smr-v2:test && pnpm py:smr-v2:lint && pnpm py:smr-v2:typecheck` · `pnpm --filter @arcaai/applications build test` · `pnpm build:api && pnpm test:unit` · `pnpm --filter @arcaai/admin-console build lint test` · e2e spec (`apps/api/tests/e2e/ai-model-discovery.spec.ts` incl. cross-tenant 404 case) **authored here, executed in Phase 7 (TASK-534)** per plan §2.2.

## 6. Acceptance & DoD

- [ ] R1–R3, R5, R6 demonstrably working; R4 outcome recorded (implemented or explicitly deferred with rationale)
- [ ] All §5 tests RED-then-GREEN with evidence pasted; gates in §5.5 green
- [ ] `GET /providers` returns within `probe_timeout × 1 + ε` with one hung provider (measured, pasted)
- [ ] Register path: factory-created row, sys-event broadcast, DTO whitelist rejection, duplicate-slug 400, provider validation — all asserted
- [ ] Discovery routes global-admin-only; cross-tenant e2e spec authored
- [ ] Console: skeletons/empty/error states, axe 0, both themes, nav unhidden + tests updated, task-defaults link live
- [ ] Comment deltas §4.2 applied; `.env.example` updated; no new env var read from TS
- [ ] Design gate satisfied (approved frame or recorded waiver, logged in §10)
- [ ] Runtime verified in a running app (`next-dev-loop` skill) — compiling ≠ working

## 7. Risks & Rollback

| Risk | Mitigation |
|---|---|
| Live probe latency on an admin page (SMR → engines round-trip) | Probes run in parallel with a 5 s per-provider cap (§3.3); console fetches lazily (drawer open, not page load), caches with `staleTime` ~30 s, and shows a `probedAt` staleness indicator + manual Refresh — the registry grid itself never waits on probes |
| Server-listed model names violating slug rules (`llama3.1:8b-instruct-q4_K_M`, `org/repo-GGUF`) | Deterministic normalization (§3.4) + `isSlugUnique` precheck; on collision an explicit-slug requirement with actionable 400 — no silent suffixing |
| False "missing-on-server" during transient probe failures | Non-`ok` probe degrades that provider's rows to `registered`/`unknown` (§3.1); no tag ever mutates data (register-only sync) |
| SMR response-shape change breaking the existing fallback path / contract tests | Additive-only fields (§3.3); `smr.contract.test.ts` extended; fallback mapper untouched |
| `lm-studio` vs `lmstudio` key confusion across surfaces | Single naming note (§2.2) + contract-pinned provider list; console renders keys verbatim from the response |
| Rollback | Purely additive: re-set `implemented: false` (nav), remove the two routes + SMR probe fields — no migrations, no data mutations, registry rows created via register remain valid ordinary `AiModel` rows |

## 8. References

- Ollama API — `GET /api/tags` (local model listing), `GET /api/ps` (running models, `expires_at`/`size_vram`): https://github.com/ollama/ollama/blob/main/docs/api.md
- LM Studio REST API (beta) — `GET /api/v0/models` (`state`, `quantization`, `max_context_length`): https://lmstudio.ai/docs/api/rest-api
- OpenAI-compat listing (LM Studio/vLLM `/v1/models`): https://platform.openai.com/docs/api-reference/models/list
- Program: [findings §3-E5/§7 GAP-C4/§6 M-04](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) · [plan §3 AD-5, §4 Phase 2](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md)
- Rules: `.claude/rules/04-application-services.md` (BaseService/sys-events/DTOs) · `05-nestjs-api.md` (guards, `IConfigService`, thin controllers) · `07-react-ui.md` · `10-skeleton-loading.md` · `11-ux-ui-principles.md` (§1 DetailDrawer, §7 badges) · `13-nextjs-apps.md` (BFF, quality gates) · `12-design-workflow.md` (gate)

## 9. Implementation Summary

_Pending_

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored (execution-ready): code-verified current state (fallback mechanics, SMR probe internals incl. the 300 s probe-timeout reuse and the `lm-studio` naming, per-engine load-state availability, existing full registry screen, DTO provider-list drift), AD-5 merge-view architecture, ordered implementation plan with exclusive file manifest, RED-first TDD plan, DoD, risks. Status Pending — awaiting owner approval + design-gate resolution. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
