# TASK-331 · Admin — Platform Ops (Audio Pipelines / Storage / Audit Log / Prisma Studio) — Production Review


| Field        | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent       | TASK-331                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Scope (code) | `apps/ui-playground/src/features/admin/{audio-pipelines,frontend-pipeline,backend-pipeline,storage,audit-logs,configurations,components/studio-page}`, `apps/ui-playground/src/features/admin/api/{audio-pipelines,tenant-storage,storage,audit-logs}.ts`, `apps/ui-playground/src/components/layout/{admin-nav-items,scope-switcher}.tsx`, `apps/ui-playground/src/providers/{sdk-provider,scope-sync}.tsx`, `apps/api/src/modules/{pstudio,audit-log,pipeline,tenant-frontend-config}`, `packages/applications/src/services/{auditLog,stt/pipeline,tenant-frontend-config}`, `packages/agentic-sdk-v2/src/hooks/{useTenantFrontendConfig,usePipelines}.ts`, `packages/database/src/prisma/db_main/{stt,audit,tenant-bucket,tenant}.prisma` + `seed/{05-tenant,05a-tenant-bucket,06-stt,10-audit-log}.ts` |
| Reviewed     | `fix/2605-review` @ e91fc450 · 2026-06-03                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Verdict      | **Ship-with-fixes**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Status       | **Remediated** — all 12 findings + Q1/Q2 resolved on `fix/2605-review` · 2026-06-03 · gate green (build 19/19, tests 34/34, typecheck + lint clean)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |


## 1. Scope & Business Context

This cluster is the platform-operations console for a multi-tenant clinical SaaS, surfaced inside `apps/ui-playground` (the `apps/admin` app does not exist). It covers four operator surfaces plus Configurations:

- **A6 — Audio-processing management.** Split across THREE nav entries (`admin-nav-items.tsx:30-32`): **Audio Pipelines** (legacy YAML CRUD, `audio-pipelines/index.tsx`), **Frontend Pipeline** (per-tenant typed-JSON capture defaults, `frontend-pipeline/index.tsx`), and **Backend Pipeline** (ASR YAML + versions/default/enable, `backend-pipeline/index.tsx`).
- **A7 — Storage & file management** (`storage/index.tsx`): tenant buckets, folder tree, blob CRUD, presigned URLs, access keys, provider config.
- **A8 — Audit log** (`audit-logs/index.tsx`): filtered, paginated, drill-down + CSV export.
- **A9 — Embedded Prisma Studio** (`components/studio-page.tsx`): raw DB access for super/global admins.
- **Configurations** (`configurations/index.tsx`): type-aware tenant settings editor with OCC.

Two operator scopes matter: **Super/Global admin** (`SUPER_ADMIN`/`GLOBAL_ADMIN`, cross-tenant) and **Tenant admin** (`TENANT_ADMIN`, pinned to one tenant). Per TASK-327 the route gate is "scope, not visibility": all admins reach the full menu (`admin-route-guard.tsx:25-31`), and server-side `X-Tenant-Id` + CASL scope the data; Prisma Studio is the one global-scope-only surface (`admin-route-guard.tsx:37-43`, `studio.tsx:7`).

The backend foundations are strong (audit scoping, Studio auditing, OCC everywhere, soft-delete). The weaknesses are concentrated in the **frontend A6 layer** (a broken global-admin code path, three overlapping pipeline UIs) and **seed realism for pipelines**.

## 2. Metrics Scorecard


| Metric                       | Super/Global admin | Tenant admin | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usability                    | 🔴                 | 🟡           | Frontend Pipeline 400s for GLOBAL_ADMIN and targets the wrong tenant for SUPER_ADMIN (`frontend-pipeline/index.tsx:65-70` + `tenant-frontend-config.service.ts:104-110`); customer tenants have zero seeded pipelines so Audio/Backend Pipeline render empty (`06-stt.ts:1488-1585`); no tenant column on the cross-tenant audit table (`audit-logs/index.tsx:281-288`). Tenant admin paths work but pipeline pages are empty + nav is redundant. |
| Clean & friendly UX/UI       | 🟡                 | 🟡           | High-quality shadcn/Radix components, OCC conflict modal, skeletons in most places — but three overlapping pipeline nav items (`admin-nav-items.tsx:30-32`), fragmented tenant switching, and rule-10 text loaders (`storage/index.tsx:432`, `audit-logs/index.tsx:338,358`).                                                                                                                                                                     |
| Production-ready + seed data | 🟡                 | 🟡           | Buckets seeded for all 5 tenants (`05a-tenant-bucket.ts:54-85`) and audit rows realistic across tenants (`10-audit-log.ts:31-541`); BUT all 12 ASR pipelines seeded under SYSTEM tenant only with no `isDefault` (`06-stt.ts:1490-1585`), no `TenantFrontendConfig` seed, dual default mechanisms, and dead legacy unscoped storage hooks (`api/storage.ts`).                                                                                     |
| Core-business / workflow fit | 🟡                 | 🟡           | Platform-ops capabilities are largely present and backend-correct, but A6 pipeline management is fragmented (create on one page, version/default/toggle on another) and the global-admin per-tenant frontend-config workflow is broken.                                                                                                                                                                                                           |


Legend: 🟢 good · 🟡 works with caveats · 🔴 broken/blocked.

## 3. Current State (file:line evidence)

**A6 — Frontend Pipeline (typed JSON).** Model `TenantFrontendConfig` (one row/tenant, `tenant.prisma:37-68`) with boolean switches + `configJson Json?`; typed shape `FrontendPipelineConfigJson` (`frontend-pipeline-config.ts:10-23`). Admin API `GET/PUT /admin/tenant-frontend-config`, `@CanManage('Tenant')`, OCC via If-Match/`expectedVersion` (`tenant-frontend-config-admin.controller.ts:22,33-66`). Service upserts one row, requires `expectedVersion` on update, and for global roles **requires** a `tenantId` (`tenant-frontend-config.service.ts:46-116`). UI renders ASR-model select + 4 switches + typed advanced fields with skeleton loading (`frontend-pipeline/index.tsx:160-291,349-356`). Vox hook passes `tenantId` as the `?tenantId=` query param (`useTenantFrontendConfig.ts:39-57`).

**A6 — Backend Pipeline (YAML).** Model `AsrPipeline` (`stt.prisma:12-54`) with `isDefault` (`:31`), soft-delete via `resourceStatus`, OCC `_version`; history `AsrPipelineVersion` unique `[asrPipelineId, versionNumber]` (`stt.prisma:61-94`). Controller `/admin/audio/pipelines` with `set-default`, `toggle` (If-Match), `versions` (`audio-pipeline.controller.ts:181-249`). Service snapshots a version only on YAML change, atomic default flip, OCC toggle, **soft-delete** (`pipeline.service.ts:111-167,177-201,208-241,384-403`). UI provides validate/save (snapshots), versions list + "load into editor", set-default, enable/disable toggle — but **no create/delete** (`backend-pipeline/index.tsx:80-132,200-352`).

**A6 — Audio Pipelines (legacy).** Same `/admin/audio/pipelines` controller via `adminClient` (`api/audio-pipelines.ts:78,103,119,133,142`). Full CRUD + form/YAML editor + super-admin tenant column (`audio-pipelines/index.tsx:585-818`), but **no** versions/default/enable-disable; delete dialog says "cannot be undone" (`:565`).

**A7 — Storage.** Tenant column for super/global admin + bucket/folder/object CRUD, presigned "copy link", delete confirms, provider-config + access-keys dialogs (`storage/index.tsx:52-746`). Scoped admin hooks hit `/admin/tenants/storage/...` (`tenant-storage.ts:80,97,133,152,173`) — except object list/upload which hit the non-admin `/storage/buckets/:name/files` plane (`tenant-storage.ts:114,218`). Presigned + delete file with confirm (`object-actions.tsx:37-108`). Models `TenantBucket`/`StorageAccessKey`/`TenantStorageConfig` are complete (`tenant-bucket.prisma:4-162`).

**A8 — Audit.** Controller-layer tenant guard (audit item "X5") on `fetchAll`, `exportCsv`, `fetchByUser` (`audit-log.controller.ts:69-73,104-108,200-204`); read-only `@CanRead('AuditLog')` (`:37`). Service pushes from/to/action/resourceType/userId filters to the DB, scopes via `buildTenantWhere` (super-admin bypass), asserts ownership in `fetchById`, soft-deletes, caps CSV at 10k, and batch-resolves responsible users (`auditLog.service.ts:129-218,225-244,356-365,377-388,408-430`). UI filter bar + drill-down drawer + CSV download (`audit-logs/index.tsx:202-364`).

**A9 — Prisma Studio.** Class `@CanManage('all')` + method `@Authorize(['manage','all'])` (super-admin only), route guard `RequireGlobalScope` (`pstudio.controller.ts:33,50,74`; `studio.tsx:7`). EVERY `query`/`sequence` is audited (item "X1") via `recordSystemAction` (`pstudio.controller.ts:80-105`), best-effort/non-blocking (`auditLog.service.ts:541-579`); GET shell no longer accepts `?token=` (`pstudio.controller.ts:44-71`).

**Tenant scoping wiring.** Global `ScopeSwitcher` → `setTenant(tenantId)` sets `tenantId` only (`scope-switcher.tsx:62-66`; `auth-store.ts:102`). SDK reads `tenantId` (`sdk-provider.tsx:33-54`) so Backend Pipeline + Audit + Configs follow the header. `setTenantKey` is deprecated and additionally sets `tenantKey` (`auth-store.ts:37-38,104`).

## 4. Findings (severity-ranked)


| #   | Sev          | Area                        | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence (file:line)                                                                                                                                                                               | Metric                          |
| --- | ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | **Critical** | A6 Frontend Pipeline        | Broken for global-scope admins. UI gates on `isSuperAdmin()` and derives target from `tenantKey`. A **GLOBAL_ADMIN** falls to the `: undefined` branch → no `tenantId` → service throws `400 "tenantId is required for global admins"`; GET error is swallowed (misleading empty state) and Save toasts an error. A **SUPER_ADMIN** reads `tenantKey`, which the header `ScopeSwitcher` (`setTenant`) never updates → edits silently target the home/stale tenant, not the selected one. | `frontend-pipeline/index.tsx:65-70,78-80,121-124,147-154`; `tenant-frontend-config.service.ts:104-116`; `scope-switcher.tsx:62-66`; `auth-store.ts:102`                                            | Usability, Core-business        |
| 2   | **High**     | A6 all three pipeline pages | Redundant/competing UIs. "Audio Pipelines" and "Backend Pipeline" both manage the SAME `AsrPipeline` via the SAME `/admin/audio/pipelines` controller, with disjoint capabilities: Audio Pipelines = create/edit/delete but no versions/default/toggle; Backend Pipeline = versions/default/toggle but no create/delete. Fully managing one pipeline requires two pages; both badged "NEW".                                                                                              | `admin-nav-items.tsx:30-32`; `api/audio-pipelines.ts:78,103,133`; `backend-pipeline/index.tsx:31,200-352` (no create/delete); `audio-pipeline.controller.ts:25-26,181-249`                         | UX, Core-business               |
| 3   | **High**     | Seed (A6)                   | No per-tenant pipeline seed. All 12 ASR pipelines + AI models are seeded under the SYSTEM tenant only, so ArcaAI/4bits/Mumbai have zero pipelines → Audio/Backend Pipeline render empty for those tenants, and Backend Pipeline offers no way to create one (dead end). No row sets `isDefault`; the actual default is a `GlobalSetting` slug, a second, unreconciled default mechanism.                                                                                                 | `06-stt.ts:25,1490-1585` (all `tenantId: DEFAULT_TENANT_ID`), `:1814-1835` (slug defaults); `backend-pipeline/index.tsx:149-155` (empty state, no create)                                          | Production-ready, Core-business |
| 4   | **High**     | A6 cross-page               | Fragmented tenant selection. Five surfaces use four different tenant signals: header `ScopeSwitcher`→`tenantId`; Audio Pipelines in-page column→`setTenantKey` (`tenantId`+`tenantKey`); Storage/Configurations→local `selectedTenantId`; Frontend Pipeline→`tenantKey`; Backend Pipeline/Audit→SDK `tenantId`. Selecting a tenant in one place does not carry to others, and Frontend Pipeline ignores the header switcher entirely (see #1).                                           | `scope-switcher.tsx:62-66`; `audio-pipelines/index.tsx:589,617-624`; `storage/index.tsx:62,119`; `configurations/index.tsx:105,148`; `frontend-pipeline/index.tsx:66-70`; `sdk-provider.tsx:33-54` | Usability, UX                   |
| 5   | Medium       | A8 Audit                    | Drill-down drawer shows "after" only. `previousData` exists in the model and seed but the drawer renders only `detail.data` — no before/after diff for compliance review.                                                                                                                                                                                                                                                                                                                | `audit-logs/index.tsx:352-359`; `audit.prisma:30`; `10-audit-log.ts:194-197,248-251`                                                                                                               | Core-business                   |
| 6   | Medium       | A8 Audit                    | No Tenant column for cross-tenant super-admin view. Super-admin sees cross-tenant rows (service bypass) but the table has no tenant column, so rows from different tenants are indistinguishable.                                                                                                                                                                                                                                                                                        | `audit-logs/index.tsx:281-288`; `auditLog.service.ts:408-411`                                                                                                                                      | Usability                       |
| 7   | Medium       | A7 Storage                  | Mixed API planes. Object list + upload call the non-admin `/storage/buckets/:name/files` plane while buckets/tree/delete/presigned use `/admin/tenants/storage/...`. Inconsistent authz surface and relies on the header tenant for the `/storage` calls.                                                                                                                                                                                                                                | `tenant-storage.ts:114,218` vs `:80,97,133,152,173`                                                                                                                                                | UX, Production-ready            |
| 8   | Medium       | A7 Storage                  | Dead legacy unscoped hooks. `api/storage.ts` hooks send no `tenantId` (operator's active-header tenant wins) and back `FilesTab`, which is exported but NOT wired into the tenant-detail tab strip (only users/departments/prompts/storage; storage uses the scoped embedded page). Latent cross-tenant confusion if ever re-mounted.                                                                                                                                                    | `api/storage.ts:50,59,72,82,96,110`; `tenants/index.tsx:79,866-872,2523-2538,2553,2716`                                                                                                            | Production-ready                |
| 9   | Low          | A7 / A8 UX                  | Rule-10 violations: text loaders instead of `<Skeleton/>`. Buckets list "Loading buckets..." and audit drawer "Loading…".                                                                                                                                                                                                                                                                                                                                                                | `storage/index.tsx:432`; `audit-logs/index.tsx:338,358`                                                                                                                                            | UX                              |
| 10  | Low          | A6 Audio Pipelines          | Misleading delete copy. Dialog says "This action cannot be undone." but the backend soft-deletes the pipeline.                                                                                                                                                                                                                                                                                                                                                                           | `audio-pipelines/index.tsx:565`; `pipeline.service.ts:384-397`                                                                                                                                     | UX                              |
| 11  | Low          | A8 Audit                    | Pagination shows only "Page N"; Next is disabled purely on `entries.length < PAGE_SIZE`; the admin API's `count` is never surfaced (no total / page count).                                                                                                                                                                                                                                                                                                                              | `audit-logs/index.tsx:318-330`                                                                                                                                                                     | UX                              |
| 12  | Low          | A6 Backend Pipeline         | No in-page indication of which tenant is being edited and no switcher; relies entirely on the header `ScopeSwitcher`. Low discoverability for super/global admins.                                                                                                                                                                                                                                                                                                                       | `backend-pipeline/index.tsx:30-145`                                                                                                                                                                | UX                              |


## 5. Solutions & Actionable Plan

Layer chain reminder: Database (Prisma) → Domain → Services (`@arcaai/applications`) → API (`apps/api`) → SDK (`@arcaai/vox`) → UI (`apps/ui-playground`). Findings 1, 2, 4, 5, 6 are UI/SDK-only; 3 is seed-only.

**Finding #1 (Critical) — Frontend Pipeline global-admin breakage.**

- Root cause: the page uses `isSuperAdmin()` (excludes `GLOBAL_ADMIN`) and reads `tenantKey` (not maintained by the header `setTenant`).
- Solution: switch the gate to `isGlobalScope()` and the target to the store's `tenantId` (the value the `ScopeSwitcher` writes). When global scope and no tenant is selected, render an explicit "Select a tenant" empty state instead of firing a request that 400s.
- TDD: extend `frontend-pipeline/__tests__/frontend-pipeline.test.tsx` — (a) GLOBAL_ADMIN with a selected tenant issues `?tenantId=<id>` and saves successfully; (b) GLOBAL_ADMIN with no tenant shows the select-tenant prompt and fires no request; (c) SUPER_ADMIN switching tenant in the header changes the request `tenantId`.
- Verify: `pnpm --filter @arcaai/ui-playground test -- frontend-pipeline`.

**Finding #2 (High) — Pipeline UI redundancy.**

- Root cause: the legacy `audio-pipelines` page was never retired after TASK-328 added `backend-pipeline`.
- Solution (decision needed — see Q1): consolidate to ONE Backend Pipeline page that adds create/delete to the existing version/default/toggle UI, and remove the `audio-pipelines` nav item + route (keep `frontend-pipeline` as the distinct client-capture surface). Quick-win interim: drop "Audio Pipelines" from `buildAdminNavItems` so operators see a single backend surface.
- TDD: `admin-nav-items.test.ts` asserts no `audio-pipelines` id; `backend-pipeline.test.tsx` covers create + delete.
- Verify: `pnpm --filter @arcaai/ui-playground test -- admin-nav-items backend-pipeline`.

**Finding #3 (High) — Pipeline seed gap.**

- Root cause: `seedAsrPipelines` only emits SYSTEM-tenant rows; `isDefault` is never set; defaults live in a `GlobalSetting` slug.
- Solution: seed 1–2 realistic pipelines per customer tenant (`SEED_CUSTOMER_TENANT_IDS` in `06-stt.ts`) with exactly one `isDefault: true` each, and reconcile the slug-based default with `AsrPipeline.isDefault` (single source of truth). Optionally seed a `TenantFrontendConfig` row per customer tenant for a non-empty Frontend Pipeline.
- TDD: extend `pipeline.service.task328.test.ts` for the "exactly one default per tenant" invariant; assert seed idempotency (re-run upserts).
- Verify (no destructive ops; requires user approval before any DB write): `pnpm --filter @arcaai/database db:seed` in a disposable/dev DB only.

**Finding #4 (High) — Fragmented tenant selection.**

- Root cause: in-page pickers (`setTenantKey`/local `selectedTenantId`) predate the global `ScopeSwitcher`.
- Solution: make `tenantId` (the `ScopeSwitcher` value) the single source of truth across Platform-Ops pages; have Audio/Storage/Configurations read it and drop the deprecated `setTenantKey`. Keep an optional in-page picker only where multi-pane selection genuinely helps (Storage), but seed it from `tenantId`.
- TDD: a shared `scope-sync` test asserting each page reads `tenantId` and reacts to header changes.
- Verify: `pnpm --filter @arcaai/ui-playground test -- scope`.

**Quick wins (Low/Medium, UI-only):**

- #5: render `detail.previousData` beside `detail.data` (before/after) in the audit drawer.
- #6: add a Tenant column to the audit table when `isGlobalScope()` (label from the row's `tenantId`).
- #9: replace text loaders with `<Skeleton/>` (`storage/index.tsx:431-432`, audit drawer).
- #10: change the audio-pipeline delete copy to "moves the pipeline to deleted (soft-delete)".
- #11: surface the admin `count` for true pagination.
- #7/#8: route storage object list/upload through the `/admin/tenants/storage/...` plane and delete the dead `api/storage.ts` + `FilesTab` (or re-scope them) to remove the latent cross-tenant path.

## 6. Seed Data Assessment

Tenants seeded: System (`__SYSTEM_`_), Global (`__GLOBAL__`), ArcaAI, 4bits, Mumbai General Hospital (`05-tenant.ts:6-42`).

- **Buckets (A7) — 🟢 realistic across tenants.** 3 system buckets (audio/attachments/misc) per tenant for all 5 tenants (`05a-tenant-bucket.ts:50-86`), correct `bucketType`/`purpose`/`pathPattern`. No `StorageAccessKey`/`TenantStorageConfig` seed, so Access-Keys and Provider-Config panels start empty (acceptable, admin-managed).
- **Audit (A8) — 🟢 realistic across tenants.** 10 Global-tenant + 13 customer-tenant rows (ArcaAI 5 / 4bits 4 / Mumbai 5) with correlation/causation IDs and `previousData` on UPDATE rows (`10-audit-log.ts:31-541`). Good coverage of login/RBAC/consultation/summary/settings events.
- **Pipelines (A6) — 🔴 gap.** 12 ASR pipelines + ~50 AI models, ALL under SYSTEM tenant (`06-stt.ts:1490-1585`). Customer tenants have none → empty pipeline pages. No `isDefault` seeded; default is a `GlobalSetting` slug (`06-stt.ts:1814-1835`) — competing mechanism vs `AsrPipeline.isDefault`.
- **Frontend config (A6) — 🟡 none.** No `TenantFrontendConfig` seed; every tenant starts at the empty state (acceptable create-on-save, but no demo data).
- **Studio (A9):** no seed required.

## 7. UX/UI Notes (rules 07/10/11)

- **Rule 10 (skeletons).** Frontend/Backend Pipeline use proper `<Skeleton/>` (`frontend-pipeline/index.tsx:349-356`, `backend-pipeline/index.tsx:360-369`); Audit list uses skeleton rows (`audit-logs/index.tsx:268-273`). Violations: buckets list text loader (`storage/index.tsx:432`) and audit drawer "Loading…" (`audit-logs/index.tsx:338,358`).
- **Rule 11 (feedback, confirms, density).** Destructive actions are confirmed (`object-actions.tsx:99-108`, `storage/index.tsx:701-711`, `audio-pipelines/index.tsx:561-570`); all mutations toast success/error. The OCC conflict modal (`configurations/index.tsx:450-462`) is exemplary. Empty states generally have icon+title+description. Watch: the Frontend Pipeline empty state is shown even on a swallowed 400 (`frontend-pipeline/index.tsx:147-159`), which misrepresents an error as "no config yet".
- **Rule 07 (React/component patterns).** Consistent `@arcaai/ui` shadcn/Radix usage, `MultiColumnLayout` for master-detail (Audio Pipelines/Storage/Configurations), TanStack Query hooks, route-level guards. Configurations is the cleanest reference (type-aware editor + JSON validation + OCC). The three-pipeline split is the main IA/UX smell.
- **Positive:** Prisma Studio is correctly the only global-scope-only surface with full per-query audit; Audit and Configurations are production-grade; OCC (If-Match/version) is applied consistently across pipelines and configs.

## 8. Open Questions / Assumptions

1. **Q1 (blocking the #2 fix):** Is `audio-pipelines` intended to be retired in favor of `backend-pipeline`, or kept as a separate "advanced YAML" surface? The consolidation plan assumes retirement.
Answer: Consolidate the interfaces to have one Audio pipeline management for tenant administration. Audio pipeline provide 2 audio-pipeline administrations: one for default frontend pipeline (using local models) and one for backend pipelines management (using backend models)
2. **Assumption:** `GLOBAL_ADMIN ≡ SUPER_ADMIN` for scope (per brief and `auth-store.ts:140-144`). Finding #1 treats Frontend Pipeline's `isSuperAdmin()` gate as a drift bug, not intended behavior.
Answer: Global admin is super admin
3. **Assumption:** A super-admin's `tenantKey` is not reliably set by the header `ScopeSwitcher` (it calls `setTenant`, not `setTenantKey`). If some other flow keeps `tenantKey` in sync with `tenantId`, finding #1's SUPER_ADMIN sub-case downgrades to Medium (GLOBAL_ADMIN 400 remains).
Answer: for api communication, we use `tenantId`, but for visualization, we cannot show the `tenantId` , we must show `tenantKey` or `tenantName` which is more human-readable
4. **Q2:** Should `AsrPipeline.isDefault` (TASK-328) supersede the `stt.config.defaults.*_pipeline_slug` GlobalSettings, or coexist? Seed reconciliation (#3) depends on the answer.
Answer: yes, we need to allow admins to control the default settings for their tenants
5. **Not executed:** per task constraints, no builds/tests/migrations/seeds were run; all findings are from static reading at the cited `file:line` on e91fc450.
Answer: Make sure you perform all migration, and all tests must be passed, resolve all collisions, before merging into `fix/2605-review` branch in current repo

## 9. Implementation Summary (2026-06-03)

All 12 findings and both open questions (Q1, Q2) were remediated across **four parallel git worktrees**, each on its own branch with strictly disjoint file ownership (zero merge conflicts), then merged into `fix/2605-review`. Every stream followed TDD (RED→GREEN→refactor) and was verified independently before merge; the combined branch was then re-verified end-to-end.

### Stream A — Audio-pipeline consolidation (`fix/2605-platform-pipelines` → `d2fc5d74`)

Findings **#1, #2, #4 (pipelines + Configurations), #10, #12**; resolves **Q1**.

- **Q1/#2 consolidation.** The three pipeline nav entries collapse into a single **Audio Pipelines** page (`/admin/audio-pipelines`) with two tabs: **Frontend Pipeline** (per-tenant capture defaults, local models) and **Backend Pipelines** (backend ASR YAML management). The Backend tab unifies the old `audio-pipelines` CRUD + dual-mode form/YAML editor with the old `backend-pipeline` versions / set-default / enable-toggle — one surface now does list + create + edit + delete + set-default + toggle + versions. No backend change was needed (`/admin/audio/pipelines` already supports all of it). The `frontend-pipeline` and `backend-pipeline` routes/dirs were removed (clean removal; old deep links now 404).
- **#1 (Critical) Frontend Pipeline global-scope breakage.** Gate switched from `isSuperAdmin()` to `isGlobalScope()`; the target tenant now comes from the store `tenantId` (the value the header `ScopeSwitcher` writes). When global-scope with no tenant selected, an explicit "Select a tenant" empty state renders and **no request is fired** (no more swallowed 400).
- **#4 tenant selection.** Store `tenantId` is the single source of truth for the API; `tenantName` is used for display (never the raw UUID). The deprecated in-page `setTenantKey` picker was removed from the consolidated page. Configurations page got a surgical fix: a `useEffect` re-syncs the super-admin local `selectedTenantId` to header changes, and the synthesized tenant row shows `tenantName` (short-id fallback). `setTenantKey` remains in the store (still used by Departments — doc-01 scope).
- **#10** delete copy now reflects soft-delete; **#12** both tabs show an in-page tenant (`tenantName`) indicator.

### Stream B — Pipeline seed + default reconciliation (`fix/2605-platform-seed` → `7f908216`)

Finding **#3**; resolves **Q2**.

- **#3 seed.** Added 2 realistic ASR pipelines per customer tenant (ArcaAI / 4bits / Mumbai) with **exactly one `isDefault: true` each**; set `isDefault` on the SYSTEM production pipeline so it agrees with the existing `default-stt-pipeline` GlobalSetting. Seeding stays idempotent and never clobbers an admin's chosen default on re-run. Added one `TenantFrontendConfig` row per customer tenant (+ Global) so the Frontend Pipeline tab is non-empty.
- **Q2 runtime reconciliation.** `userPreferences.resolveRemoteConfig` now resolves the default pipeline as: per-user admin override → **tenant `AsrPipeline.isDefault`** (via the repo's existing `findDefault(tenantId)`) → GlobalSetting fallback. Additive and backward-compatible — Global-tenant users (who own no `AsrPipeline` rows) resolve exactly as before. No `packages/domains` (generated) change was required.

### Stream C — Storage plane unification + dead-code cleanup (`fix/2605-platform-storage` → `73e03e46`)

Findings **#7, #8, #9**.

- **#7** Object **list** and **upload** now go through the admin plane: two new routes on `TenantBucketController` (`GET`/`POST /admin/tenants/storage/buckets/:id/objects`) backed by new `listObjects`/`uploadObject` service methods (guarded `@CanRead`/`@CanCreate('Storage')` + `@TenantOwnedResource`, mirroring the existing `deleteObject`/`getBucketTree` pattern). The frontend hooks switched from the non-admin `/storage/...` plane (by name) to the admin plane (by bucket id).
- **#8** Deleted the dead `api/storage.ts`, the unused `useDeleteTenantObject` hook, and the orphaned `FilesTab` (+ its export and imports) from `tenants/index.tsx`; removed the legacy re-exports.
- **#9** Replaced the "Loading buckets…" text loader with a `<Skeleton/>` matching the bucket-list shape.

### Stream D — Audit log UX + data (`fix/2605-platform-audit` → `7e8c200d`)

Findings **#5, #6, #9, #11**.

- **#5** Drill-down drawer now renders a **Before/After** pair when `previousData` is present (single "Payload" for CREATE/LOGIN rows with no prior state).
- **#6** A **Tenant** column shows only under `isGlobalScope()`, resolving `tenantId`→name via `useAdminTenants` (truncated-id fallback, never a raw UUID). This required adding `tenantId` to `AuditLogResponse` (so `AutoEntityMapper` emits it) and to the vox `AuditLogEntry` type.
- **#9** Both drawer "Loading…" text loaders replaced with `<Skeleton/>`.
- **#11** The vox `useAuditLog` hook now preserves the paginated envelope `count` (array return shape unchanged, so other callers are unaffected); the page shows "Page N of M · X total" and disables Next via `page*PAGE_SIZE >= count`.

### Files changed (by stream)

- **A (pipelines):** `audio-pipelines/{index.tsx,frontend-pipeline-tab.tsx,backend-pipelines-tab.tsx}` (+ tests), `api/audio-pipelines.ts`, `components/layout/admin-nav-items.tsx` (+ test), `configurations/index.tsx`, `hooks/use-admin-preferences.ts`, `routeTree.gen.ts`; **deleted** `frontend-pipeline/`, `backend-pipeline/`, and their routes.
- **B (seed):** `seed/{05-tenant,06-stt,index}.ts`, `__tests__/seed.test.ts`, `userPreferences/userPreferences.service.ts` (+ test).
- **C (storage):** `tenant-bucket.controller.ts` (+ test), `tenant-bucket.service.ts` / `ITenantBucketService.ts` / `dto/*` (+ test), `api/{tenant-storage,index}.ts`, `storage/index.tsx` (+ test); **deleted** `api/storage.ts`; `tenants/index.tsx` (FilesTab removed).
- **D (audit):** `audit-logs/index.tsx` (+ test), `useAuditLog.ts` (+ test), `auditLog/dto/auditLog.response.ts` (+ mapper test).

### Verification (combined `fix/2605-review`)

```
BUILD     : 19/19 turbo tasks ✓ (only the pre-existing ui-playground chunk-size warning)
TESTS     : 34/34 turbo test tasks ✓ — ui-playground 902, applications 4655,
            vox 3253, api 1515, database 655
TYPECHECK : @arcaai/ui-playground ✓ · @arcaai/vox ✓ · @arcaai/applications ✓
LINT      : @arcaai/ui-playground 0 errors ✓ · @arcaai/api 0 errors ✓
```

### Deviations / notes

- **Routes removed (no redirect shim)** for the old `frontend-pipeline` / `backend-pipeline` pages — bookmarked deep links now 404; use `/admin/audio-pipelines`.
- **Q2 runtime change** is the only behavioral (non-UI) change; it is additive with a GlobalSetting fallback and covered by new tests. The Python STT worker's `stt.config.defaults.*_pipeline_slug` GlobalSettings are untouched (separate concern).
- **No Prisma migration** was needed — `AsrPipeline.isDefault` and `TenantFrontendConfig` already exist in the schema. The new seed data requires a `db:seed` run to take effect (idempotent upserts; no destructive SQL).
- `Departments` page still uses `setTenantKey` (doc-01/T4 scope) and was intentionally left untouched.

## 10. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-03 | Review created (docs-only); 12 findings + Q1/Q2 raised at `e91fc450`. | this doc |
| 2026-06-03 | **Remediation** of all 12 findings + Q1/Q2 across 4 parallel worktrees → merged into `fix/2605-review` (`5bf08195`, `a96f5b11`, `c7fe1869`, `1b851fcd`); zero conflicts; full gate green. See §9. | see §9 "Files changed" |

