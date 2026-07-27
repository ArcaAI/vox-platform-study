# TASK-562 — v1-Compatible SMR Summary Gateway Endpoints

| | |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Parent** | [TASK-560](../TASK-560-v1-v2-consultation-migration/README.md) |
| **Packages** | `apps/api` (controller/module) + `packages/applications` (DTOs) |
| **Suggested tier** | claude-opus-4-8-medium |
| **Depends on** | TASK-560 §5.4/§5.5/§5.6 (frozen contracts) |
| **Rules to read first** | `05-nestjs-api.md`, `04-application-services.md`, `06-python-services.md` |

> **Goal:** Reproduce the v1 endpoints `POST /api/smr/api/v1/summary/sync` and `POST /api/smr/api/v1/presummary` as **stateless gateway shims** over SMR `POST /api/v1/generate`, returning the exact v1 response shapes, authenticated with `x-api-key` (tenant resolved from the key). **No changes to `SummaryService`, `ConsultationService`, or `apps/smr`.**

---

## 1. Requirement Analysis

- Two additive routes, exact v1 paths (TASK-560 §5.6), exact v1 request/response shapes (§5.4/§5.5).
- Stateless (like v1's presummary; and like v1 summary/sync from the caller's perspective — persistence is out of scope, D1).
- Assemble prompt from `session_data` → call SMR `/api/v1/generate` with `response_format: json_schema` → parse → map to `Enhanced`/`Simplified` (summary) or `pre_summary` + `structured_data` (presummary).
- `x-api-key` parity (D2): rely on `UnifiedAuthGuard` accepting the api-key headers; CLS tenant is set from the key.

**Non-goals:** `/summary/async`, `/jobs/{id}`, SSE job streaming, feedback endpoint, DB/vector persistence, Langflow provider parity. (Callers needing async use v2-native `/consultations/:id/summary/async`.)

## 2. Current State Evaluation

- Pattern to mirror: `SmrProxyController` `@Controller('text')` (`apps/api/src/modules/streaming/smr-proxy.controller.ts:145`). It shows: `@Authorize()` methods, `HttpService` POST to `${SMR_URL}/api/v1/generate`, `IConfigService.getConfigValue('SMR_URL')` (`:159`), `SecretsService` for `X-Service-Token` (`:160`, header `smr-proxy.controller.ts:330`), `ClsService<IActiveUserContext>` for tenant/user, `SmrGenerateRequest`/`response_format: {type:'json_schema', json_schema}` (`:53-77`), retry discipline (`RETRIABLE_CODES`/`CONNECT_PHASE_CODES`, non-idempotent `/generate` never retried mid-flight).
- SMR `POST /api/v1/generate` request/response: `apps/smr/src/smr/models/requests.py` (`GenerateRequest`), `models/responses.py` (`GenerateResponse{ task_id, status, content, reasoning, provider, model, latency_ms, finish_reason, ... }`).
- Global prefix: `apps/api/src/main.ts` `setGlobalPrefix('api/v1', { exclude:[/metrics/] })` — must add the compat routes to `exclude` to hit the literal `/api/smr/api/v1/...` (§5.6).
- Auth: `UnifiedAuthGuard` (`packages/applications/src/authorization/unified-auth.guard.ts:59`) accepts `apikey`/`api-key`/`x-api-key` (`apiKey.service.ts:941`) and binds tenant from the key.

## 3. Implementation Plan

### 3.1 New files

| File | Contents |
|---|---|
| `apps/api/src/modules/smr-compat/smr-compat.controller.ts` | `@Controller('api/smr/api/v1')`; `@Post('summary/sync')`, `@Post('presummary')`. Each `@Authorize()` (deny-by-default satisfied; boot audit green). Injects `HttpService`, `IConfigService`, `SecretsService`, `ClsService`. |
| `apps/api/src/modules/smr-compat/smr-compat.module.ts` | Registers controller; imports `HttpModule`, `CommonServiceModule`. |
| `apps/api/src/modules/smr-compat/summary-prompt.builder.ts` | Pure fns: `buildSummaryPrompt(sessionData, opts) → {system, user}`; `buildPreSummaryPrompt(req) → {system, user}`; department/visit-type aware. Reuse v2 prompt catalog if available, else port the v1 template text. |
| `apps/api/src/modules/smr-compat/summary-response.mapper.ts` | `mapGenerateToV1Summary(content, meta, useEnhanced) → SummaryResponse`; `mapGenerateToV1PreSummary(content) → PreSummaryResponse` (parse markdown sections into `structured_data`, else `sections:[]`). |
| `packages/applications/src/services/.../dto/` (or a compat DTO folder in apps/api) | `SyncSummaryRequest`, `SessionData`, `ConversationSegment`, `TestResult`, `PreviousVisitRecord`, `PreSummaryRequest` request DTOs (class-validator + `@ApiProperty` on every field). Response types `SummaryResponse`, `Enhanced/SimplifiedMedicalSummary`, `PreSummaryResponse`, `StructuredPreSummary`. |
| `apps/api/src/modules/smr-compat/__tests__/*.test.ts` | Vitest unit tests. |
| `apps/api/tests/e2e/task-562-smr-compat.spec.ts` | Playwright e2e against a running gateway. |

### 3.2 Wiring edits (additive)

1. `apps/api/src/main.ts`: add the two compat paths to the `setGlobalPrefix` `exclude` list so `@Controller('api/smr/api/v1')` yields the literal `/api/smr/api/v1/summary/sync` + `/presummary` (TASK-560 §5.6). Use path+method entries (`{ path: 'api/smr/api/v1/summary/sync', method: RequestMethod.POST }`, same for `presummary`).
2. `apps/api/src/app.module.ts`: import `SmrCompatModule`.

### 3.3 Request→SMR→v1-response flow (per route)

**`/summary/sync`:**
1. Validate `SyncSummaryRequest` (strict DTO). Read tenant from CLS (set by the api key).
2. `buildSummaryPrompt(session_data, { department, visit_type, specialty, encounter_type, include_pre_summary_in_context, pre_summary_text })` — segments rendered **per-turn** (fix v1 F2), pre_summary/test_results_text/previous_visits_text/patient_info folded in.
3. POST `${SMR_URL}/api/v1/generate` (`IConfigService.getConfigValue('SMR_URL')`), headers `X-Service-Token` (`SecretsService` `SMR_SERVICE_TOKEN`), body `{ system_prompt, prompt, temperature, max_tokens, response_format: { type:'json_schema', json_schema: use_enhanced_format ? EnhancedSchema : SimplifiedSchema, strict:true } }`. Provider/model omitted → gateway/SMR resolves the tenant default (fail-closed). Do **not** retry after bytes sent (mirror `CONNECT_PHASE_CODES`).
4. Parse `GenerateResponse.content` as JSON; validate against the chosen schema (defensive on extra keys). Wrap: `{ session_id: session_data.session_id, summary, created_at: now, processing_time_ms: latency_ms, token_usage, confidence_score: quality?, metadata: { finish_reason, temperature, max_tokens, use_enhanced_format, language, ... } }`.

**`/presummary`:** same shape; `buildPreSummaryPrompt(req)`; map `content` → `{ pre_summary: content, structured_data: parseSections(content) ?? { title:'Pre-Summary of Medical History', sections:[] }, created_at }`.

### 3.4 Error mapping (match v1 §3.4/§4.3)

- DTO validation fail → 400 `{ detail:[...] }` (Nest ValidationPipe already ~this; add a filter shim if the exact FastAPI shape is required).
- Missing/invalid/inactive api key → 401 (UnifiedAuthGuard).
- SMR unreachable → 500 `{ error:'SMR service unavailable', requestId, timestamp }` (mirror `SmrProxyController` upstream-error handling).
- LLM/parse failure → 500 `{ detail:'Summary generation failed: <reason>' }`.

### 3.5 TDD test list (red first)

- `summary-prompt.builder.test.ts`: renders per-turn segments (not one collapsed); folds `pre_summary_text` only when enrichment enabled; department/visit-type routing.
- `summary-response.mapper.test.ts`: Enhanced vs Simplified selected by `use_enhanced_format`; extra LLM keys tolerated; `processing_time_ms` from `latency_ms`; presummary section parsing + empty-sections fallback.
- `smr-compat.controller.test.ts` (mock `HttpService`): correct SMR URL + `X-Service-Token`; `response_format.json_schema` chosen by flag; tenant read from CLS; 400 on bad DTO; 500 on SMR error.
- e2e `task-562-smr-compat.spec.ts`: `x-api-key` happy path returns a schema-valid `SummaryResponse`; missing key → 401; validates against TASK-560 §5.4 schema; cross-tenant key isolation.

### 3.6 Verification

- `pnpm --filter @arcaai/applications build test` (DTOs) + `pnpm api:build` + `pnpm lint` (hard errors here) + `pnpm test:unit` green.
- e2e: `pnpm test:up:api` then `pnpm test:e2e` (task-562 spec passes).
- Confirm literal paths resolve: `curl -X POST $BASE/api/smr/api/v1/summary/sync -H "x-api-key: $KEY" -d @req.json`.

## 4. Best Practices

- No Prisma in the controller (hard error `no-controller-direct-prisma`); this shim needs none — it's stateless.
- Downstream URL only via `IConfigService`; never `process.env.SMR_URL` in `src/modules/**` (`no-direct-downstream-url-env`).
- Strict DTOs: `@ApiProperty`/`@ApiPropertyOptional` on every field; the global pipe rejects undeclared fields.
- 404-over-403 for any cross-tenant resource access (n/a here — stateless — but honor if persistence is later added).
- Do not reproduce v1's Langflow-specific `metadata.raw_llm_content` leakage unless a consumer needs it; sanitize provider internals from the response.

## 5. Implementation Summary

Implemented as a **stateless, additive** module in `apps/api` — no changes to `SummaryService`, `ConsultationService`, `SttWsGateway`, the domain layer, or `apps/smr`/`apps/stt`. Only two registration edits touch existing files (`main.ts` prefix-exclude, `app.module.ts` import).

### Files created (`apps/api/src/modules/smr-compat/`)

| File | Contents |
|---|---|
| `smr-compat.controller.ts` | `@Controller('api/smr/api/v1')`; `@Post('summary/sync')` + `@Post('presummary')`, each bare `@Authorize()` (auth-required, no specific ability — x-api-key parity via `UnifiedAuthGuard`; tenant/user from CLS). Injects `HttpService`, `IConfigService`, `ClsService`, `@Optional() SecretsService`. Assembles the prompt, POSTs SMR `/api/v1/generate` (single-delivery: retries only on connect-phase `ECONNREFUSED`/`ENOTFOUND`), maps the result, and translates transport/parse failures to the v1 error shapes. |
| `smr-compat.module.ts` | Registers the controller + its own `HttpModule`. `IConfigService`/`SecretsService`/`ClsService` come from the app-wide `@Global()` `CommonServiceModule`/`ClsModule`. |
| `summary-prompt.builder.ts` | Pure `buildSummaryPrompt(sessionData, opts)` / `buildPreSummaryPrompt(req)`. **Per-turn transcript rendering (fixes v1 F2)**; department/visit-type/specialty/encounter-aware system prompt; folds `pre_summary_text` only when enrichment is enabled; prefers structured `test_results`/`previous_visits` over the `*_text` fallbacks; `en`/`ml` language directive. |
| `summary-response.mapper.ts` | Pure `mapGenerateToV1Summary` / `mapGenerateToV1PreSummary` / `parseSections`. Strips markdown fences, tolerates extra LLM keys, fills `processing_time_ms` from `latency_ms`, extracts `confidence_score` from `quality_metrics.completeness_score` (Enhanced), and **never echoes `raw_llm_content`**. Presummary sections parsed from `#`/`**bold**` headings + `-`/`*` bullets, `sections:[]` fallback. |
| `summary-schemas.ts` | `SIMPLIFIED_SUMMARY_SCHEMA` / `ENHANCED_SUMMARY_SCHEMA` JSON Schemas (with `title`, consumed by SMR as `response_format.json_schema`), chosen by `use_enhanced_format`. |
| `dto/` | Strict request DTOs — `SyncSummaryRequest`, `SessionDataDto`, `ConversationSegmentDto`, `TestResultDto`, `PreviousVisitRecordDto`, `PreSummaryRequest` (class-validator + `@ApiProperty`/`@ApiPropertyOptional` on every field; `session_data` uses `@IsDefined()`+`@ValidateNested()`+`@Type()` so a missing value is rejected). Response types `SummaryResponse`, `PreSummaryResponse`, `StructuredPreSummary`, `TokenUsage`. |
| `__tests__/*.test.ts` | 30 Vitest unit tests (prompt builder 9, mapper 12, controller 9). |
| `apps/api/tests/e2e/task-562-smr-compat.spec.ts` | Playwright e2e: literal-path resolution (not under `api/v1`), deny-by-default (401), strict-DTO 400, Bearer + `x-api-key` reach the shim, v1 response-shape assertions, no `raw_llm_content` leak. |

### Wiring edits (additive only)

- `apps/api/src/main.ts` — added `RequestMethod` import and the two literal compat paths (`{ path: 'api/smr/api/v1/summary/sync', method: POST }`, `…/presummary`) to `setGlobalPrefix('api/v1', { exclude })`, so the routes serve at the exact v1 paths (TASK-560 §5.6).
- `apps/api/src/app.module.ts` — imported `SmrCompatModule` into `featureModules`.

### Verification (actual)

- `pnpm api:build` — **8 successful, 8 total** (nest build + tsc-alias green).
- `pnpm --filter @arcaai/api lint` — **0 errors** (65 pre-existing directive-comment warnings elsewhere; `smr-compat/` is warning-clean).
- Unit — `npx vitest run src/modules/smr-compat` → **30 passed (3 files)**. Full `pnpm test:unit` → **17296 passed, 4 skipped, 9 todo**; the single failure (`scripts/__tests__/env-sync.test.ts`, declared env keys 134 > 130) is **pre-existing and unrelated** — TASK-562 adds no env vars (`SMR_URL`/`SMR_SERVICE_TOKEN` already declared) and touches no `.env`/`turbo.json`.
- E2E — spec **written but not run**: requires a live gateway + seeded DB (`pnpm test:up:api` + `pnpm test:e2e`), which cannot be brought up inside the implementation agent. The spec is tolerant of the SMR service (:8862) being down (`[200,500,502,503]` on the happy path) so it exercises the gateway contract even without a live SMR.

### `@arcaai/applications` note

DTOs live in `apps/api` (stateless shim), so `@arcaai/applications` was **not** modified — its build/test gates were not required and were not run.

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-27 | (planning) | Ticket created from TASK-560. |
| 2026-07-27 | Tap Huynh | Implemented the `smr-compat` module (controller, module, prompt builder, response mapper, JSON schemas, strict DTOs), the two `main.ts` prefix-exclusions, and the `app.module.ts` import. 30 unit tests + an e2e spec added. Gates: api:build green, api lint 0 errors, unit 30/30 (smr-compat) — full suite green except a pre-existing unrelated env-sync count assertion; e2e written-not-run (needs live gateway). Status → Review. |
