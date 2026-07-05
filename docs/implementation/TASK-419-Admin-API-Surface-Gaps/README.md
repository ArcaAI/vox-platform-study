# TASK-419 — Admin API Surface Gaps (gateway work feeding the Admin Console)

- **Status**: Review
- **Type**: feature — new/changed NestJS gateway surfaces required by TASK-415 review decisions
- **Created**: 2026-07-04
- **Origin**: TASK-415 capabilities-matrix review (section 6 gap resolutions + decisions 6–7)

## Requirement Analysis

The TASK-415 review resolved several capability gaps into concrete gateway work so the Admin Console can build real screens against them:

1. **Evaluation golden sets/runs REST surface** — `packages/applications/src/services/eval` is service-layer only; expose admin CRUD/read endpoints (beyond the read-only `GET /admin/harness/eval-runs*`).
2. **Notifications, resource subscriptions, webhooks controllers** — services + Prisma models exist with no public controllers; a webhook/notification management screen needs them.
3. **Guardrail / NLP admin surface** — configuration lives inside the Python services with no gateway admin exposure; design a safe admin read/config plane.
4. **Prisma Studio in production behind a dedicated permission** (TASK-415 Decision 7) — replace the dev-only fail-closed gate (`shouldEnablePrismaStudio`) with production-capable registration guarded by a dedicated CASL subject (e.g. `manage:PrismaStudio`) granted only to `GLOBAL_ADMIN` policy sets; keep the truthful `/status` probe.
5. **AI model registry guard re-pin** (TASK-415 Decision 6) — `/admin/ai-models*` is class-guarded `manage:AiModel` (tenant-scoped); re-pin to global-admin-only to match the console posture.
6. **Stream-ticket scopes for admin SSE routes** (found during TASK-415 Phase 6, 2026-07-05) — `GET /admin/dna-writing-styles/jobs/:jobId/stream` and `GET /audio/transcription-jobs/:id/stream` lack `@StreamScope`, so single-use tickets minted via `POST /auth/stream-ticket` are rejected (401) at the gateway. The console currently ships labeled polling fallbacks on both screens; adding the decorators lets the `useEventStream` ticket path replace them (no console changes needed beyond removing the fallback labels).

## Current State Evaluation

See `docs/implementation/TASK-415-Hope-Admin-Console/capabilities-matrix.md` section 6 (gap inventory) and rows 11–12 (AI models, Prisma Studio). Each work item follows the layer chain: database (if needed) → domains → applications → api, with CASL policies seeded accordingly.

## Implementation Plan (high level — detail per item before starting)

Each numbered item above becomes a workstream with its own TDD slice (failing controller e2e/unit test → implement → verify) and policy/seed updates. Items 4 and 5 are authorization-only and should land first (small, unblock console tiers 10–19); items 1–3 need API design review before implementation.

Execution order (2026-07-05): **6 → 5 → 4 → 1 → 2 → 3** — the authorization items unblock the console first; the new REST surfaces follow.

### Item 6 — Stream-ticket scopes (detailed plan)

- `GET /admin/dna-writing-styles/jobs/:jobId/stream` gets `@StreamScope({ namespace: 'dna_job', param: 'jobId' })` — `dna_job` is the namespace the console (`useDnaJobProgress`) and the Vox SDK (`useDnaStyle`) already mint tickets for.
- `GET /audio/transcription-jobs/:id/stream` gets `@StreamScope({ namespace: 'transcription_job', param: 'id' })` — matches the console's `transcription_job:<id>` scope. The route keeps its existing `@TenantOwnedResource` pre-stream tenant assertion.
- TDD: unit tests asserting the `stream-scope` metadata on both handlers (mirrors `consultation-job.controller` tests) fail first, then the decorators land.
- Console: SSE becomes the primary transport. The DNA hook's 2 s poll and the transcription detail's 5 s poll become the documented error fallback (poll only while the stream is in `error`); "Polling fallback" labels and the TASK-419-gap copy are removed. Console unit tests updated accordingly.
- Out of scope (deliberate): the self-service `GET /dna-writing-styles/jobs/:jobId/stream` route also lacks `@StreamScope`, but it is the TASK-420 playground plane — not touched here.

### Item 5 — AI model registry guard re-pin (detailed plan)

- `AiModelAdminController` class guard changes `@Authorize(['manage','AiModel'])` → `@Authorize(['manage','all'])` per TASK-415 Decision 6 (matrix row 11). Unit test updated to lock the new posture.
- The `manage:AiModel` grant inside `tenant-full-access` stays in the seed (subject unchanged for future tenant-plane reads); the CONTROLLER is what stops accepting it.

### Item 4 — Prisma Studio in production (detailed plan)

- New CASL subject `PrismaStudio`. New GLOBAL policy row `prisma-studio-manage` (`manage:PrismaStudio`) seeded and attached to the GLOBAL_ADMIN policy set (and legacy SUPER_ADMIN set until TASK-417 completes the merge — same policy list today).
- `shouldEnablePrismaStudio` drops the `NODE_ENV === 'development'` pin: the module registers whenever `ENABLE_PRISMA_STUDIO === 'true'` (fail-closed default: flag absent → OFF in every environment).
- `PrismaStudioController` + `PrismaStudioStatusController` re-pin from `manage:all` to `manage:PrismaStudio` (defense-in-depth: env flag AND permission both required). `/status` stays truthful — same predicate, unconditionally registered.
- Console pstudio screen keeps working unchanged (still calls `GET /admin/pstudio/status`); matrix row 12 note updated.

### Item 1 — Eval golden sets REST surface (API design — FINAL)

- Path: `/admin/harness/golden-sets*` on the existing `HarnessAdminController` — NOT a new `/admin/eval` module. Rationale: eval-run reads already live at `GET /admin/harness/eval-runs*` with the exact tenant-resolution + `HarnessEval` CASL conventions this surface needs; runs filter by `?goldenSetId=`, so sets/cases/runs form one consultation-eval plane. A second module would duplicate the resolver and split the Swagger tag.
- Endpoints (minimal, per the EvalService's actual capabilities — create only; the service has no update/delete, so none are exposed):
  - `GET /admin/harness/golden-sets` — paginated list (`read:HarnessEval`), `?tenantId=` for platform admins.
  - `GET /admin/harness/golden-sets/:id` — one set (`read:HarnessEval`), 404 when absent for the tenant.
  - `GET /admin/harness/golden-sets/:id/cases` — case metadata list: id/label/timestamps ONLY (`read:HarnessEval`). Transcript/reference-note are Vault-Transit ciphertext (TASK-369 Phase 6) and are NEVER returned on the admin read plane (case totals come from the list's `total`; a separate `caseCount` on the set detail was dropped as redundant).
  - `POST /admin/harness/golden-sets` — create (`manage:HarnessEval`).
  - `POST /admin/harness/golden-sets/:id/cases` — add case (`manage:HarnessEval`); 404s when the parent set is absent (no orphan writes), and the 201 response is the PHI-safe metadata projection (payload never echoed).
- Service layer: `EvalService` gains repository-backed `listGoldenSets` / `getGoldenSet` / `listGoldenCases` reads + `addGoldenSet` / `addGoldenCase` admin-plane creates (create + response projection). Existing `HarnessEval` subject reused — no NEW policy rows, but the `HarnessEval` grant in `harness-platform-manage` / `harness-tenant-manage` / `tenant-full-access` was upgraded `read` → `manage` (e2e proved tenant admins could not reach the POST routes on `read` alone; `manage` implies `read` in CASL, so the read plane is unchanged). `HarnessAudit` deliberately stays read-only (WORM).
- Sys-events on the creates are DEFERRED: the generated `ResourceType` enum has no GoldenSet/GoldenCase values (adding them is a codegen change), and TASK-330 Phase 0 explicitly scoped eval writes as data-layer-only. Recorded here as a known follow-up.

### Item 2 — Webhooks / notifications / resource subscriptions controllers (API design — FINAL)

- Services were fully built (CRUD + sys-events + soft delete + tenant guards); only the controllers (and one delivery-log service read) were missing. Controllers are thin delegation with the DTO mapper at the edge, mirroring `ApiKeyController`; If-Match OCC fold mirrors `DepartmentController`.
- `WebhookController` (`admin/webhooks`, class `@CanManage('Webhook')` — `tenant-full-access` already grants tenant-scoped `manage:Webhook`; global admins via `manage:all`):
  - `GET /admin/webhooks` (paginated; `?tenantId=` routes through `fetchAllByTenantId`, service-enforced SUPER_ADMIN-only cross-tenant), `GET :id`, `POST`, `PATCH :id` (If-Match OCC — the ONLY item-2 service with a CAS write), `DELETE :id` (soft).
  - Delivery log: `GET /admin/webhooks/:id/deliveries` (`read:WebhookRunHistory`, method-level override). `WebhookRunHistory` has no `tenantId`; the new `WebhookService.fetchRunHistory` scopes through the parent webhook (load-then-assert → 404 cross-tenant, SUPER_ADMIN bypass). Append-only delivery writer does not exist yet — the list is empty until a dispatcher lands; the read surface is still the console's contract.
- `NotificationController` (`admin/notifications`, class `@CanManage('Notification')`): `GET` (paginated, `?tenantId=` as above), `GET :id`, `PATCH :id`, `DELETE :id` (soft). No admin POST — notifications are emitted by the system, not authored by admins. NOTE: planned "If-Match OCC" was dropped — `NotificationService.update` is a plain (non-CAS) write, and demanding a header the service ignores would be dishonest.
- `ResourceSubscriptionController` (`admin/resource-subscriptions`, class `@CanManage('ResourceSubscription')`): `GET` (paginated), `GET :id`, `POST`, `PATCH :id` (plain patch — same non-CAS reasoning), `POST :id/toggle` (ENABLED↔DISABLED), `DELETE :id` (soft). NOTE: the seeded `user-profile-own` policy grants every user conditional `manage:ResourceSubscription (targetUserId=self)`, which passes the TYPE-level guard — so doctors CAN reach these routes, with rows pinned to their tenant by the service (identical to the `@CanManage('ApiKey')` + `api-key-own-manage` posture, TASK-305 M-1). Webhooks/notifications stay tenant-admin-only (no doctor grant exists on those subjects).
- New application-layer surface: `WebhookService.fetchRunHistory` + `WebhookRunHistoryResponse`/`PaginatedWebhookRunHistoryResponse` DTOs + mapper methods. Existing DTO mappers reused for all three resources. Sys-events fire inside the existing service methods (create/update/delete/toggle) — nothing extra needed at the controller layer.

### Item 3 — Guardrail / NLP admin read plane (API design — FINAL)

- Read-only status/config exposure; neither Python service exposes config mutation internally, so none is built (per ticket rule). The e2e spec locks this in (POST on the plane → 404/405).
- New `AiServiceAdminController` (`admin/ai-services`, class `@Authorize(['manage','all'])` — platform infra tier: engine/model/infra internals, not tenant data, so tenant admins get 403) + `AiServiceProxyClient` (mirrors `HarnessOpsClient`; URLs from `IConfigService.getConfigValue('GUARDRAIL_URL'|'NLP_URL')` with local-dev defaults, `@Optional()` injection like the vault-rotation worker):
  - `GET /admin/ai-services/guardrail/status` — proxies guardrail `GET /api/health` (detailed, admin-only so checks are not stripped).
  - `GET /admin/ai-services/guardrail/config` — proxies `GET /api/medical/config` + `GET /api/guardrail/types` into one read (`{ medicalValidation, analysisTypes }`); non-secret engine settings only.
  - `GET /admin/ai-services/nlp/status` — proxies NLP `GET /api/v1/health` (detailed per-model checks; this doubles as NLP's "config" — its loaded-models inventory — because NLP has no config endpoint; nothing is invented).
- Upstream errors map: HTTP error from the service → same status passthrough; transport error → 503 (the `HarnessOpsClient.toHttpError` pattern). Neither Python service uses service-token auth (plain internal HTTP), so no token header is sent.

## Implementation Summary

All six items landed 2026-07-05 (execution order 6 → 5 → 4 → 1 → 2 → 3). TDD throughout: every slice started from a failing unit test; layer chain respected (database seed → applications → api → console).

### New/changed endpoints (path → guard)

| # | Endpoint | Guard |
|---|---|---|
| 6 | `GET /admin/dna-writing-styles/jobs/:jobId/stream` | + `@StreamScope({ namespace: 'dna_job', param: 'jobId' })` (JWT or single-use ticket) |
| 6 | `GET /audio/transcription-jobs/:id/stream` | + `@StreamScope({ namespace: 'transcription_job', param: 'id' })`; keeps `@TenantOwnedResource` |
| 5 | `/admin/ai-models*` (class) | `manage:AiModel` → `manage:all` |
| 4 | `GET/POST /admin/pstudio`, `GET /admin/pstudio/status` (both classes) | `manage:all` → `manage:PrismaStudio` (new GLOBAL policy `prisma-studio-manage`, seeded to GLOBAL_ADMIN) |
| 1 | `GET /admin/harness/golden-sets`, `GET :id`, `GET :id/cases` | `read:HarnessEval` |
| 1 | `POST /admin/harness/golden-sets`, `POST :id/cases` | `manage:HarnessEval` |
| 2 | `GET/POST /admin/webhooks`, `GET/PATCH/DELETE :id` | class `manage:Webhook` (PATCH requires If-Match, 428 without) |
| 2 | `GET /admin/webhooks/:id/deliveries` | `read:WebhookRunHistory` (method override) |
| 2 | `GET /admin/notifications`, `GET/PATCH/DELETE :id` | class `manage:Notification` (no POST by design) |
| 2 | `GET/POST /admin/resource-subscriptions`, `GET/PATCH/DELETE :id`, `POST :id/toggle` | class `manage:ResourceSubscription` |
| 3 | `GET /admin/ai-services/guardrail/status`, `guardrail/config`, `nlp/status` | class `manage:all` (read-only proxy plane, no mutations) |

### Per-layer changes

- **Database (seeds only — no schema change, no migration)**: `01-policy.ts` adds `prisma-studio-manage` (GLOBAL, `manage:PrismaStudio`) and upgrades `HarnessEval` `read`→`manage` in `harness-platform-manage` / `harness-tenant-manage` / `tenant-full-access`; `03-role.ts` attaches `prisma-studio-manage` to `GLOBAL_ADMIN`. `seed.test.ts` locks all of it (policy count 21, rule shapes).
- **Domains**: no changes (all needed repositories existed; `WebhookRunHistoryRepository` was already generated).
- **Applications**: `EvalService` + `listGoldenSets`/`getGoldenSet`/`listGoldenCases`/`addGoldenSet`/`addGoldenCase` + PHI-safe DTOs (`golden-set.response.ts`); `WebhookService` + `fetchRunHistory` (tenancy via parent webhook, 404 cross-tenant, GLOBAL bypass) + `webhookRunHistory.response.ts` + mapper methods; `WebhookResponse` no longer exposes `hashedSecret` (never defined on the DTO). Sys-events fire in the pre-existing service mutations; eval creates defer sys-events (no `ResourceType.GoldenSet/GoldenCase` enum values — codegen change, recorded follow-up).
- **API**: new modules `webhook`, `notification`, `resource-subscription`, `ai-service-admin` (controller + `AiServiceProxyClient`); `harness-admin` extended with the 5 golden-set routes + `EvalServiceModule`; `pstudio` re-pinned & `shouldEnablePrismaStudio` now reads ONLY `ENABLE_PRISMA_STUDIO` (fail-closed); `ai-model-admin` re-pinned; `@StreamScope` added to the two SSE routes. All registered in `app.module.ts`. Stale TASK-307 assertion in `controller-route-renames.test.ts` retuned to `manage:PrismaStudio`.
- **Console (item 6)**: `useDnaJobProgress` and the transcription-job detail now run SSE-first via `useEventStream` (ticket path), polling only as the documented error fallback; "Polling fallback" labels removed. Console tests updated.
- **E2E**: new `task-419-stream-ticket-scopes.spec.ts` (ticket mint + SSE auth on both routes, wrong-scope rejection) and `task-419-admin-surfaces.spec.ts` (CASL matrices, golden-set PHI-safe round-trip, webhook OCC lifecycle + delivery log + soft delete, ai-services 401/403/403 + 200-or-503, no-mutation probe).

### Verification evidence (2026-07-05, final state of tree incl. concurrent TASK-417 sweep)

- `packages/database` seed tests: **334 passed** (`seed.test.ts`). Full db suite: 804/806 — the 2 failures (`seed-global-settings` count, `tenant-scope` drift) are owned by the in-flight TASK-417/entitlements changes, not this ticket.
- `pnpm --filter @arcaai/domains test`: **1299 passed** | 2 skipped. Build clean.
- `packages/applications` vitest: **5801 passed** | 4 skipped (268 files). Build clean. Lint: repo-wide pre-existing prettier warnings only; files added by this ticket are clean.
- `apps/api` vitest: **1987 passed** | 4 skipped (117 files). `pnpm build:api` clean. `pnpm lint` (api) clean.
- Console gates: `test` **498 passed** (73 files), `lint` clean (`--max-warnings 0`), `build` clean.
- Integration: `pnpm test:integration` **102 passed** (6 files).
- E2E (`pnpm test:e2e` against `pnpm test:api:up` + isolated test infra): **536 passed, 1 failed, 17 skipped** — the one failure is `task-401-impersonation.spec.ts` E3 asserting legacy "super administrator" copy against the TASK-417-renamed "global administrator" message (417's sweep). Both TASK-419 specs pass in full (20/20 targeted run).

### Deferred (with reasons)

- Sys-events for golden-set/case creates — `ResourceType` enum lacks values; adding them is a `@arcaai/tools` codegen change out of scope here.
- Webhook delivery-log WRITER (dispatcher) — item 2 required the read surface; no dispatch pipeline exists yet, so the log lists empty.
- Eval-run/score write surfaces — `EvalService.recordEvalRun/recordEvalScore` exist but are harness-internal write paths; the admin plane exposes reads (`/admin/harness/eval-runs*`, pre-existing) and dataset curation only.
- Guardrail/NLP config MUTATION — neither Python service exposes internal config writes; per ticket rule nothing was invented.
- Self-service `GET /dna-writing-styles/jobs/:jobId/stream` still lacks `@StreamScope` — TASK-420 playground plane.

## Change History

| Date | Change |
|---|---|
| 2026-07-04 | Ticket created from the TASK-415 review gap resolutions. |
| 2026-07-05 | Items 6, 5, 4 landed (stream-ticket scopes + console SSE-primary, ai-models re-pin, production-capable Prisma Studio behind `manage:PrismaStudio`). |
| 2026-07-05 | Items 1, 2, 3 landed (golden-sets surface on `/admin/harness`, webhook/notification/resource-subscription controllers + delivery-log read, `/admin/ai-services` guardrail/NLP read-only proxy). `HarnessEval` grant upgraded `read`→`manage` in the three harness policies after e2e proved tenant admins could not create sets. Status → Review. |
