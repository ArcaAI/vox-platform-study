# TASK-446 — Agent Playground: Guardrails + NER gateway routes

- **Status**: Completed (2026-07-09 — unit + API e2e green against the live gateway)
- **Type**: feature (API gateway + admin-console)
- **Owner**: apps/api + admin-console
- **Related**: follow-up to **TASK-442** (shipped the two tabs disabled as a documented API gap). Mirrors `SmrProxyController` (`text/*`) and `AiServiceProxyClient` (`/admin/ai-services`).

## Requirement Analysis

TASK-442 shipped the Agent Playground with **Guardrails** and **NER** tabs rendering an in-tab API-gap `EmptyState`, because the gateway exposed **no browser/user-plane inference route** for either — only the GLOBAL_ADMIN-only read-only `admin/ai-services/*` status/config plane. This ticket adds the user-plane proxy routes and wires the two tabs to real input→verdict / input→entity-list panels.

### Acceptance criteria

- [x] `POST ai/guardrail/analyze` → Guardrail `POST /api/guardrail/analyze`; `POST ai/nlp/entities` → NLP `POST /api/v1/classify/tokens`.
- [x] Routes are user-plane `@Authorize()` (any authenticated caller under their own account — GLOBAL_ADMIN or TENANT_ADMIN), NOT `/admin/*`.
- [x] class-validator DTOs (`@ApiProperty`); camelCase in → snake_case upstream; responses proxied verbatim.
- [x] `IConfigService` for `GUARDRAIL_URL` / `NLP_URL`; upstream-status passthrough, 503 on transport failure.
- [x] Guardrails + NER tabs call the new routes and render verdict / entity panels.

## Current State Evaluation (verified 2026-07-08)

- **Pattern to mirror**: `SmrProxyController` (`apps/api/src/modules/streaming/smr-proxy.controller.ts`) — `@Controller('text')`, per-route `@Authorize()` (empty pair ⇒ any authenticated user via the global `UnifiedAuthGuard`), `IConfigService.getConfigValue('SMR_URL')`, `HttpService.axiosRef`.
- **Existing outbound client**: `AiServiceProxyClient` (`ai-service-admin`) already resolves `GUARDRAIL_URL`/`NLP_URL` and reads guardrail/nlp health+config — but is READ-ONLY by design and sends **no service token** (its own doc: *"Neither service uses service-token auth (plain internal-network HTTP)"*). Confirmed: **no `GUARDRAIL_SERVICE_TOKEN`/`NLP_SERVICE_TOKEN` secret exists** (only `SMR_SERVICE_TOKEN` / `HARNESS_SERVICE_TOKEN`).
- **Upstream contracts** (source of truth apps/guardrail, apps/nlp):
  - Guardrail `POST /api/guardrail/analyze` (mounted `prefix="/api"`): req `{ text, guardrail_type: content_safety|pii_detection|prompt_injection|comprehensive }`, resp `{ safe, issues[], confidence, processing_time_ms, request_id, timestamp, error? }`.
  - NLP `POST /api/v1/classify/tokens` (router `prefix="/classify"` under `/api/v1`): req `{ text, aggregation_strategy?, language? }`, resp `{ entities: Entity[], model_version }`; `Entity { id, text, normalized_text, entity_type, confidence, position{start,end}, model_version? }`.

### Corrections to the original spec

1. **No `X-Service-Token`** — no such secret exists and the existing guardrail/nlp plane uses plain internal HTTP. The proxy sends no token (a unit test asserts this).
2. **Tabs colocated under the `playground-llm` feature**, not separate `playground-guardrails`/`playground-ner` features — rule 13 forbids features importing each other, and the Agent Playground screen (in `playground-llm`) renders them.
3. **New `ai-inference` module** with its own thin client — the read-only `AiServiceProxyClient` is left untouched (its doc commits to READ-ONLY).

## Implementation Plan / Summary

### Backend — `apps/api/src/modules/ai-inference/`

- `ai-inference.client.ts` — `AiInferenceClient.analyzeGuardrail(body)` / `classifyTokens(body)`: POST via `HttpService`, URLs from `IConfigService` (`GUARDRAIL_URL`/`NLP_URL`, local-dev fallbacks), 30s/15s timeouts, no service token, error contract mirroring `AiServiceProxyClient` (upstream status passthrough, 503 transport).
- `dto/analyze-guardrail.request.ts` (`AnalyzeGuardrailRequest { text, guardrailType? }`, `@IsIn(GUARDRAIL_TYPES)`), `dto/extract-entities.request.ts` (`ExtractEntitiesRequest { text, aggregationStrategy?, language? }`).
- `ai-inference.controller.ts` — `@Controller('ai')`, `@Post('guardrail/analyze')` + `@Post('nlp/entities')`, each `@Authorize()`; maps camelCase→snake_case (`guardrail_type` default `comprehensive`, `aggregation_strategy` default `simple`, `language` omitted when absent).
- `ai-inference.module.ts` (imports `HttpModule`), registered in `app.module.ts`.

### Frontend — `apps/admin-console/src/features/playground-llm/`

- `api/inference-client.ts` (`postJson('ai/guardrail/analyze' | 'ai/nlp/entities')`), `api/types.ts` (verbatim snake_case `GuardrailAnalysis` / `NerEntity` / `NerResult`), `api/hooks.ts` (`useAnalyzeGuardrail`, `useExtractEntities`).
- `components/guardrails-tab.tsx` (text + check-type select → safe/unsafe `StatusBadge` + issues + confidence), `components/ner-tab.tsx` (text → entity list with type badge + confidence). Wired into `playground-llm-screen.tsx`, replacing the two `EmptyState` tabs.

## Verification evidence

- **apps/api**: `pnpm build:api` clean; `pnpm lint` clean; **full unit suite 2030 passing / 4 skipped / 0 failing** (incl. `ai-inference` module 23 = client 7 + controller 4 + DTO-validation 12). The DTO tests drive the REAL global `ValidationPipe` config (transform + whitelist + forbidNonWhitelisted + forbidUnknownValues) — the class-validator contract the controller unit tests bypass and that otherwise only the (stack-dependent) e2e covered.
- **admin-console**: `pnpm lint` clean; **full suite 833 passing** (110 files, incl. new guardrails-tab 3 + ner-tab 3).
- **API e2e (2026-07-09, live gateway :8868, seeded DB, run serially to respect the 5/60s login throttle)**: `apps/api/tests/e2e/task-446-ai-inference.spec.ts` — **4/4 pass**: deny-by-default 401, DTO validation 400 (missing text), unknown-`guardrailType` 400 (whitelist), and "authenticated user-plane caller reaches the proxy (never 401/403)".
- **Live curl (2026-07-09, gateway :8868, super_admin/GLOBAL_ADMIN token)** — direct proof of the full path on the running gateway:
  - `POST /api/v1/ai/guardrail/analyze` unauth → **401**; missing `text` → **400**; unknown `guardrailType` → **400**; smuggled snake_case `guardrail_type` → **400** (forbidNonWhitelisted); valid body → **503** with the exact `AiInferenceClient` message `AI inference request failed (POST /api/guardrail/analyze)` (auth+validation passed, controller→client executed, upstream refused since services down).
  - `POST /api/v1/ai/nlp/entities` — same shape (400 on missing text; 503-reach-through on valid body).
- **Not exercised (environment limit, not a code gap)**: a real guardrail verdict / NER entity list. The Guardrail (:8863) and NLP (:8864) services START under `arcaenv` but their first-run ONNX model downloads (`gliner-guard-*`) stall on rate-limited HuggingFace (no `HF_TOKEN`) in this environment, so they never reach `healthy`. The gateway proxy is proven to reach them (503 = connection-refused mapped by our client); with the services up it would forward their response verbatim. Upstream inference is pre-existing `apps/guardrail` / `apps/nlp`, out of this ticket's scope.

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Implemented the user-plane `ai/*` gateway proxy (new `ai-inference` module: controller + client + DTOs, registered in AppModule) and wired the Agent Playground Guardrails + NER tabs to it. Corrected the spec (no service token; tabs colocated in `playground-llm`; new module leaves the read-only `AiServiceProxyClient` untouched). apps/api unit 2018 pass + build clean; admin-console 833 pass; lint clean both. e2e spec written (needs stack). Status: Review. |
| 2026-07-08 | Closed the DTO-validation coverage gap: added `ai-inference.dto.test.ts` (12 tests) driving the real global `ValidationPipe` config — required/empty/maxLength/enum-whitelist/forbidNonWhitelisted for both request DTOs. apps/api unit now 2030 pass; lint clean. |
| 2026-07-09 | Ran the API e2e against the live gateway — **4/4 `task-446-ai-inference.spec.ts` pass** (run serially, `--workers=1`, to respect the 5/60s login throttle); plus direct curl proof of 401 / 400×3 / 503-with-our-error on both routes. Guardrail/NLP services boot under `arcaenv` but their HF model downloads stall (rate-limited, no token), so real inference output isn't exercised here — the gateway reach-through is proven. Status: Review → **Completed**. |
