# TASK-407 — Tenant-Admin Tail Surfaces (Stores detail · Audio processing · Agent Jobs · Harness)

- **Ticket**: TASK-407
- **Created**: 2026-07-02
- **Updated**: 2026-07-02
- **Status**: Completed
- **Classification**: feature (tenant-detail surface extensions, additive backend/SDK)

## 1. Requirement Analysis

Backlog P2-2 (`docs/admin-console-open-items-review.md` §3b) lists four tenant-admin
surfaces that exist in the design taxonomy but were never built: **Stores (detail)**,
**Audio processing**, **Agent Jobs**, and **Harness**. All four are tenant-scoped and
live under the existing `/tenants/$tenantId/**` tenant-detail route tree (TASK-379),
not the global nav.

### Design sources

| Surface | Design source | Coverage |
|---|---|---|
| Stores detail | `docs/designs/admin/unbuilt-super-admin-surfaces.md` §2 "Stores" (spec-only, no Figma frame) | Bucket table columns, Store Detail (usage, quota, objects, keys) |
| Audio processing | same doc §2 "Audio Processing" (spec-only) | Pipeline card + recordings/job status list |
| Agent Jobs | **no explicit design** — implied tail surface only | Flagged: built from backend data + TASK-379/380 patterns |
| Harness | same doc §2 "Harness" (spec-only): sub-tabs Policy · Eval runs · Audit trail · Gate queue | Read-only observability; SLA/verdict/gate queue |

Where the spec is text-only, layout mirrors the established TASK-379/380 tenant-detail
patterns (stats tiles, `ResponsiveDataGrid`, detail sheets, shadcn `Tabs`).

### Acceptance criteria

1. Three new tabs (`Audio processing`, `Agent Jobs`, `Harness`) + a deepened Storage
   tab (bucket-detail sub-route) render under `/tenants/$tenantId/**` for tenant-admins
   (own tenant) and super-admins (any tenant).
2. Read-only everywhere: no object deletion, no job mutation, no workflow signals.
3. Harness views degrade honestly (em-dash / unavailable card) when the harness
   service or Temporal is down; DB-backed observability (audit/eval/gate queue) still renders.
4. CASL: tenant-admin own-tenant 200, cross-tenant 403/404, super-admin cross-tenant 200.
5. No schema changes; backend additions are thin + additive.

## 2. Current State Evaluation

### Backend (reused as-is)

- `GET /admin/tenants/storage/buckets` (+`/:id`, `/:id/objects`, `/:id/objects/presigned-url`, `/summary/tree`) — `tenant-bucket.controller.ts` (TASK-376). MinIO-backed object listing already exists.
- `GET /admin/tenants/storage/config` + `/admin/tenants/storage/keys` — provider config + access keys (TASK-380).
- `GET /admin/transcription-jobs` (+`/stats`, `/status/:status`) — tenant-wide supervision (`admin-transcription-job.controller.ts`).
- `GET /admin/pipelines`, `GET /audio-recordings?consultationId=` — pipeline + per-consultation recordings.
- `GET /admin/prompt-templates` (+`/analytics/usage`, `/:id/usage`) — prompt templates + aggregated usage analytics.
- `GET /admin/harness/policy|audit|eval-runs|eval-runs/:id|gate-queue|workflows` — `harness-admin.controller.ts` (DB-backed observability + Temporal-backed workflows; workflows list returns `temporalAvailable:false` shape when Temporal is down).
- `GET /admin/tenants/:id/usage` — tenant usage stats incl. `storageQuotaBytes` (TASK-386).

### Gaps → thin additive changes (no schema changes)

1. **`TenantBucketResponse.quotaBytes` missing** though `TenantBucket.quotaBytes` landed in TASK-386 → add to DTO + mapper.
2. **`PromptTemplateResponse` missing `lastTestScore`/`lastTestAt`** though the SDK `PromptTemplate` type already declares them and DB columns exist (vault-encrypted `lastTestOutput` deliberately NOT exposed) → add to DTO + mapper.
3. **No tenant-wide agent-run listing** — `PromptUsageRecord` rows exist (written by explore/summary usage tracking) but only aggregated analytics are exposed → add `GET /admin/prompt-templates/usage-records` (paginated, tenant-scoped, optional `promptTemplateId` filter).
4. **SDK**: `useTenantBuckets` lacks `listObjects`; no hook for `/admin/harness/*`; no usage-records call → additive SDK methods + new `useHarnessAdmin` hook.

### CASL posture (verified in seeds)

`tenant-full-access` (tenant-admin) already grants `manage PromptTemplate`,
`manage TenantBucket`, `read TranscriptionJob`(via manage tenant scope),
`manage HarnessPolicy/Workflow`, `read HarnessAudit/HarnessEval`. Controllers reuse
existing `@Authorize`/ability checks — no policy seed changes.

## 3. Implementation Plan

### Backend (TDD)

| # | Change | Files | Test |
|---|---|---|---|
| B1 | `quotaBytes?: number \| null` on bucket response | `packages/applications/src/services/tenant-bucket/dto/tenant-bucket.response.ts`, `tenant-bucket.dto.mapper.ts` | mapper unit test |
| B2 | `lastTestScore?/lastTestAt?` on template response | `packages/applications/src/services/prompt-management/dto/prompt-template.response.ts`, `prompt-management.dto.mapper.ts` | mapper unit test |
| B3 | `GET /admin/prompt-templates/usage-records` (page/limit/promptTemplateId) | controller + `prompt-management.service.ts` + new `prompt-usage-record.response.ts` | service + controller unit tests |

Route B3 is declared before `:id` param routes to avoid path shadowing.

### SDK (`@arcaai/vox`)

- `useTenantBuckets.listObjects(bucketId, prefix?)` + `LIST_OBJECTS` endpoint const.
- `usePrompts.listUsageRecords(params)` + endpoint const.
- New `useHarnessAdmin` (read-only: `getPolicy`, `listAudit`, `listEvalRuns`, `getEvalRun`, `listGateQueue`, `listWorkflows`) + endpoint consts + barrel exports.

### Frontend (`apps/admin`)

- `routes/_authenticated/tenants/$tenantId/route.tsx`: TABS += Audio · Agent Jobs · Harness (8 total; mobile Select already handles overflow).
- `storage.tsx` → `storage/index.tsx` (adds quota/type columns + row-link) + `storage/$bucketId.tsx` (bucket meta, quota, read-only objects browser with prefix filter + download via presigned URL, scoped access keys).
- `audio-processing.tsx`: job stats tiles + pipeline summary + paginated transcription-jobs grid + detail sheet.
- `agent-jobs.tsx`: KPI tiles + paginated `PromptUsageRecord` runs grid (template/doctor/department resolved) + per-agent last-test summary.
- `harness.tsx`: shadcn `Tabs` — Policy / Eval runs / Audit trail / Gate queue (+ Temporal workflows strip with honest degraded state).
- New feature folders: `features/storage/`, `features/audio-processing/`, `features/agent-jobs/`, `features/harness/` (pure display-model helpers + Vitest units).

### E2E

- `apps/api/tests/e2e/task-407-tail-surfaces.spec.ts`: CASL matrix + happy paths per surface (buckets+quota, objects list, transcription jobs+stats, usage-records shape, prompt lastTest fields, harness policy/audit/eval/gate-queue/workflows-degraded).
- `apps/admin/e2e/task-407-tail-surfaces.spec.ts`: tabs render + core content across 3 viewports (`SKIP_DB_PRECHECK=true`); re-run `task-379-tenant-detail.spec.ts` for regression.

## 4. Implementation Summary

All four surfaces shipped under `/tenants/$tenantId/**` as planned. No schema changes,
no destructive actions, all backend additions thin + additive.

### Backend (built exactly as planned B1–B3)

| Change | Files |
|---|---|
| `quotaBytes` on bucket response | `packages/applications/src/services/tenant-bucket/dto/tenant-bucket.response.ts`, `tenant-bucket.dto.mapper.ts` (+ new mapper test) |
| `lastTestScore`/`lastTestAt` on template response | `packages/applications/src/services/prompt-management/dto/prompt-template.response.ts`, `prompt-management.dto.mapper.ts` (+ mapper test) |
| `GET /admin/prompt-templates/usage-records` (paginated, `promptTemplateId` filter, declared before `:id` routes) | `prompt-management.controller.ts`, `prompt-management.service.ts`, `IPromptManagementService.ts`, new `dto/prompt-usage-record.response.ts` (+ service/controller tests) |
| `@CanRead('AsrPipeline')` method-level overrides on audio admin GETs | `apps/api/src/modules/streaming/admin-transcription-job.controller.ts` (+ controller test) — the class-level `@CanManage('Tenant')` blocked tenant-admins (seeded policy grants read/update, not manage); design §5.8 grants tenant-admins AsrPipeline access, mirroring `TenantBucketController`'s `@CanRead('Storage')` posture. Doctors remain 403. |

### SDK (`@arcaai/vox`)

- `useTenantBuckets.listObjects(bucketId, prefix?)` + `TenantBucketObject` type.
- `usePrompts.listUsageRecords(params)` + `PromptUsageRecord`/`PaginatedPromptUsageRecords` types.
- New `useHarnessAdmin` hook (getPolicy / listAudit / listEvalRuns / getEvalRun / listGateQueue / listWorkflows) with 503 → `HarnessUnavailableError` for honest degradation.
- Endpoint consts in `core/constants.ts`; barrel exports in `hooks/index.ts` + `core.ts`; dist rebuilt.

### Frontend (`apps/admin`)

- `routes/_authenticated/tenants/$tenantId/route.tsx` — TABS += Audio Processing · Agent Jobs · Harness.
- `storage.tsx` → `storage/index.tsx` (Type/Quota columns, row links) + new `storage/$bucketId.tsx` (meta, usage-vs-quota bar, provider config with masked credentialsRef, scoped access keys, read-only object browser with prefix filter).
- New `audio-processing.tsx` (pipeline card, 4 stat tiles, paginated jobs table + status filter, read-only detail sheet).
- New `agent-jobs.tsx` (agents summary w/ last-test score + paginated PromptUsageRecord run history w/ agent filter).
- New `harness.tsx` (Tabs: Policy read-only · Eval runs + score sheet · WORM audit trail w/ chain verdict · Gate queue + Temporal workflows with unavailable card).
- New feature folders (pure helpers + Vitest units): `features/storage/store-format.ts`, `features/audio-processing/job-format.ts`, `features/agent-jobs/run-model.ts`, `features/harness/harness-display.ts`.
- One-line shared-shell fix: `components/layout/app-shell.tsx` mobile drawer `ScrollArea` gained `min-h-0` — the nav (grown by sibling tasks) pushed the working-tenant switcher off-viewport on mobile, breaking task-379 test 3; nav now scrolls inside the drawer.

### Test evidence (final full-suite runs, 2026-07-02)

- Unit: `packages/applications` 5758 passed (4 skipped); `@arcaai/vox` SDK 3491 passed (196 files); `apps/api` 1924 passed (4 skipped); `apps/admin` 397 passed (51 files).
- Builds: `pnpm build:api` clean; SDK dist rebuilt; `apps/admin` `tsc --noEmit` + `pnpm build` clean.
- Live API E2E: `task-407-tail-surfaces.spec.ts` **21/21 passed** (CASL 401/403/200 matrix per role incl. cross-tenant 404 probes; buckets+quota; MinIO object listing; jobs list/stats/by-status; usage-records shape + lastTest fields; harness policy/audit/eval/gate-queue; workflows 200-or-503).
- Live FE E2E: `task-407-tail-surfaces.spec.ts` 6 tests × 3 viewports **18/18 passed**; task-379 regression **18/18 passed** (36 total in combined run).

### MinIO test-env provisioning (data fix, not code)

DB rows for seeded buckets existed but physical MinIO buckets were missing in
`hope-minio-test` → object listing 500 (`NoSuchBucket`). Created via `mc mb --ignore-existing`:
`hope-audio-global`, `hope-attachments-global`, `hope-misc-global`,
`task219-bucket-1782897984146` (__GLOBAL__) and `hope-audio-arcaai`,
`hope-attachments-arcaai`, `hope-misc-arcaai` (ARCAAI); seeded 1 sample object
into `hope-audio-global`.

## 5. Flags / Deviations

- **Agent Jobs has no drawn design** — built from `PromptUsageRecord` + prompt test
  metadata mirroring TASK-379/380 patterns (flagged per task instructions).
- Stores/Audio/Harness specs are text-only (`unbuilt-super-admin-surfaces.md` §2, "spec-only, not drawn").
- Harness Temporal-backed workflow list degrades to an "unavailable" card; DB-backed
  observability stays live. E2E tolerates both states.
- `lastTestOutput` (vault-encrypted) intentionally NOT exposed on list responses.

## 5a. Not built (flagged targets)

- Stores: key rotation / provider-config mutations (buttons disabled, "Not yet available").
- Audio: cascade toggles + per-model runtime metrics (design TARGET).
- Agent Jobs: per-run token/latency drill-down (records don't carry it).
- Harness: policy editing + HarnessPolicyChange history; aggregate eval dashboards.

## 6. Change History

- 2026-07-02 — Ticket created; exploration + plan.
- 2026-07-02 — Implemented B1–B3 + SDK + 4 FE surfaces; audio admin CASL method-level fix; MinIO test-bucket provisioning; API E2E 21/21, FE E2E 36/36 (incl. task-379 regression + mobile-drawer `min-h-0` fix). Status → Completed.
