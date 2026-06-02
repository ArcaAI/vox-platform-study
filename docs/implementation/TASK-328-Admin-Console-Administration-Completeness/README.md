# TASK-328 — Phase 2: Administration Completeness

| | |
|---|---|
| Ticket Number | TASK-328 |
| Short name | Admin-Console-Administration-Completeness |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Completed` (2026-06-02) — A1–A8 shipped + merged to `fix/2605-review` |
| Type | feature |
| Scope | `apps/ui-playground/`, `apps/api/`, `packages/database/`, `packages/domains/`, `packages/applications/`, `@arcaai/vox` |
| Depends on | **TASK-326** (security) + **TASK-327** (scope shell) |

> Completes admin spec items **A4–A8** and the **A1–A3** tenant-detail gaps from TASK-325. Per **Q3**, new surfaces consume `@arcaai/vox` hooks (extend the SDK first where missing). Per **Q5**, the frontend pipeline is **typed JSON**.

---

## 1. Requirement Analysis

### 1.1 Acceptance criteria
- [x] **A6 (X4)** — **Frontend** pipeline config as typed JSON: `TenantFrontendConfig` model (`asrModel`, `noiseCancel`, `vad`, `voiceEnrollment`, `diarization`, `configJson`) + `GET/PUT /admin/tenant/frontend-config` + a "Frontend Pipeline" tab. **Backend** pipeline gains per-tenant **default** assignment + `AsrPipelineVersion` history + enable/disable toggle.
- [x] **A4** — Prompt **quality/score testing**: `lastTestScore/Output/At` fields + `POST /admin/prompt-templates/:id/test` (SMR-scored) + a Test panel; usage analytics grouped by dept/user/time (`GROUP BY` on `PromptUsageRecord`); diff includes `variables`; pagination pushed to the repository; remove dead `PRE_SUMMARY` client enum.
- [x] **A5** — DNA **aggregate dashboard**: `GET /admin/dna-writing-styles/dashboard?tenantId=` (`usersWithStyle`, `avgVersions`, `recentActivity` from `DnaUsageRecord`) → Stat strip + chart above the existing browser.
- [x] **A7** — Storage: wire delete file/bucket (with confirm dialogs); access-key UI (`StorageAccessKey`); provider/topology config UI (`tenant-storage-config-admin`); presigned download links.
- [x] **A8** — Audit: date-range/action/resource filters; responsible-user column; before/after `data` detail drawer; CSV export endpoint.
- [x] **A1–A3** — Tenant-detail completeness: Prompt-Templates + tenant-scoped Storage tabs; voice-profile + DNA + all-namespace settings sections in `UserDetailDialog`; `UserDepartment` join model + assignment endpoints; "manage selected tenant as tenant admin" CTA.
- [x] Skeleton/empty/toast per rules `10`/`11`; OCC (`If-Match`) on all mutations; gates green (§4).

### 1.2 Non-goals
- Developer playgrounds (TASK-329). Security scoping (TASK-326).

---

## 2. Current State Evaluation
TASK-325 §2.3 A1–A8 (committed vs gaps, file-cited) and §2.7 (reuse: `tool-ui/chart`+`stats-display` for dashboards, `pipeline-config-editor` for YAML, `version-diff-panel` for diffs, `tool-ui/data-table` for tables).

---

## 3. Implementation Plan (TDD, layer order per surface)
Sequence (each independently shippable): **A6 frontend pipeline** → **A4 prompt testing** → **A5 DNA dashboard** → **A7 storage** → **A8 audit** → **A1–A3 tenant-detail**. For each: DB (if needed) → Domain (Factory/Mapper/Repo) → Application (Service + DTO) → SDK hook (Q3) → API controller → UI (reuse §2.7 components). RED tests at the service + controller layers; UI smoke per feature.

> **DB:** A6 (`TenantFrontendConfig`), A4 (prompt test fields + `PromptTemplateCategory` enum), A6 (`AsrPipelineVersion`), A1–A3 (`UserDepartment`, `UserProfile.preferredPromptTemplateId`) are **additive** migrations — no destructive ops.

---

## 4. Verification Gates
```
pnpm db:migrate && pnpm db:generate            # additive migrations
pnpm test:unit --filter @arcaai/domains
pnpm test:unit --filter @arcaai/applications
pnpm build:sdk && pnpm --filter @arcaai/vox test   # new hooks
pnpm build:api && pnpm test:e2e
pnpm --filter @arcaai/ui-playground type-check && pnpm --filter @arcaai/ui-playground test
# ReadLints on every edited file → clean
```

---

## 5. Implementation Summary

### A4 — Prompt quality/score testing + analytics + diff + pagination (`wave3/a4-prompt-testing`)
Schema was already migrated (frozen); this slice threaded the columns through the domain/app/SDK/UI layers only — **no `prisma migrate`/`db` and no `git`** were run.

- **Domain** (`packages/domains`): added `lastTestScore`/`lastTestOutput`/`lastTestAt` to `PromptTemplateEntity` (interface + private field + getter/setter via `setProperty`), `PromptTemplateModel`, and `PromptTemplateFactory` (`?? null`); auto-mapper verified to carry the fields (round-trip test). Added `PromptUsageRecordRepository.groupByDepartment/groupByDoctor/groupByDay` (Prisma `groupBy`, day bucketed in-memory) and `PromptTemplateRepository.findPaginated(where,page,limit)`.
- **Application** (`packages/applications`): `IPromptManagementService` + service gained `testPromptTemplate()` (interpolates variables → SMR `/generate` via injected `HttpService`/`ConfigService`/`SecretsService`, deterministic word-count score, OCC `updateWithVersion`, `broadcastSysEvent`), `getUsageAnalytics()`, and `listPromptTemplatesPaginated()`. New DTOs: `TestPromptTemplateRequest`, `PromptTestResultResponse`, `PromptUsageAnalyticsResponse` (+ `byDepartment/byDoctor/byDay`).
- **API** (`apps/api`): `POST /admin/prompt-templates/:id/test` (`@RequiresIfMatch`/`@ExpectedVersion` OCC, tenant-scoped) + `GET /admin/prompt-templates/analytics/usage` (registered **before** `:id` routes); `list` now delegates pagination to the repository.
- **SDK** (`@arcaai/vox`): `PROMPT_TEMPLATE_ENDPOINTS.TEST`/`USAGE_ANALYTICS`; `usePrompts().test()`/`.analytics()`; `compareVersions()` now diffs **content + variables (JSON)**; new types (`TestPromptInput`, `PromptTestResult`, `PromptUsageAnalytics`, …) exported via the types barrel.
- **UI** (`apps/ui-playground` `/admin/prompts`): `PromptTestPanel` (run test → score badge + output, skeleton + toast), `PromptUsageAnalyticsPanel` (dept/doctor/day bars), variables wired into the `VersionDiffPanel`; admin-client hooks `useTestPrompt`/`usePromptUsageAnalytics`.
- **`PRE_SUMMARY`**: **kept** — it is a live `PromptTemplateCategory` member consumed by the admin badge map + consultation/summary context-item types (not dead).
- **Gates** (all green): domains 1102✓, applications 4518✓, vox 3111✓ (148 files), ui-playground 737✓ + type-check✓, `build:api`✓, lint clean. Live SMR scoring deferred to CI (unit-tested with a mocked SMR client).

### A5–A8 + A1–A3 — shipped slices (roll-up)

Each slice was implemented end-to-end on its own `wave3/*` worktree behind a green gate (domain→app→SDK→API→UI, RED tests at service/controller, UI smoke) and merged to `fix/2605-review`; the per-slice file lists live in the cited merge commits. None ran `git push` or `prisma migrate` (the schema-first sub-wave landed all additive columns/models up front).

| Slice | Scope | Commit |
|---|---|---|
| **A5** | DNA **aggregate dashboard** — `GET /admin/dna-writing-styles/dashboard` (usersWithStyle / avgVersions / recentActivity) + stat strip & chart above the browser | `17c527fc` |
| **A6** | **Frontend** (typed-JSON `TenantFrontendConfig`) + **backend** pipeline config (`AsrPipelineVersion` history, per-tenant default, enable/disable) + admin nav wiring | `08dd869d`, `a9015d6d` |
| **A7** | **Storage** management — delete file/bucket (confirm dialogs), access-key UI, provider/topology config, presigned downloads | `081c56d5` |
| **A8** | **Audit** — date-range/action/resource filters, responsible-user column, before/after `data` detail drawer, CSV export | `a65fbe2a` |
| **A1–A3** | **Tenant-detail** (Prompt-Templates + tenant-scoped Storage tabs) + `UserDetailDialog` (voice/DNA/all-namespace settings) + `UserDepartment` assignment + "manage selected tenant as tenant admin" CTA | `80e97afd` |

---

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 2). Scope = A4–A8 + A1–A3 tenant-detail; Q3 SDK-first, Q5 typed-JSON frontend config. Status `Pending`. | this README |
| 2026-06-02 | **A4 implemented** end-to-end (domain→service→controller→SDK→UI) on `wave3/a4-prompt-testing`. Test endpoint + usage analytics + repo pagination + variables-in-diff; `PRE_SUMMARY` kept (live). All gates green. | `packages/domains/src/{entities,models,factories}/generated/core/PromptTemplate*`, `…/repositories/generated/core/{PromptTemplate,PromptUsageRecord}Repository.ts`, `packages/applications/src/services/prompt-management/**`, `apps/api/src/modules/prompt-management/prompt-management.controller.ts`, `packages/agentic-sdk-v2/src/{core/constants.ts,types/prompt.ts,types/index.ts,hooks/usePrompts.ts}`, `apps/ui-playground/src/features/admin/{api/prompts.ts,prompts/index.tsx,prompts/prompt-test-panel.tsx,prompts/prompt-usage-analytics-panel.tsx}` |
| 2026-06-02 | **A5 shipped** — DNA aggregate dashboard endpoint + stat strip/chart. Gate green; merged to `fix/2605-review`. | commit `17c527fc` (see merge for file list) |
| 2026-06-02 | **A6 shipped** — frontend (typed-JSON `TenantFrontendConfig`) + backend pipeline config (`AsrPipelineVersion`, per-tenant default, enable/disable) + admin nav. Gate green; merged. | commits `08dd869d`, `a9015d6d` |
| 2026-06-02 | **A7 shipped** — storage management (delete file/bucket + confirm, access-key UI, provider/topology config, presigned downloads). Gate green; merged. | commit `081c56d5` |
| 2026-06-02 | **A8 shipped** — audit filters (date-range/action/resource) + responsible-user column + before/after detail drawer + CSV export. Gate green; merged. | commit `a65fbe2a` |
| 2026-06-02 | **A1–A3 shipped** — tenant-detail (Prompt-Templates + Storage tabs), `UserDetailDialog` (voice/DNA/settings), `UserDepartment` assignment, "manage as tenant admin" CTA. Gate green; merged. **TASK-328 → `Completed`.** | commit `80e97afd` |
