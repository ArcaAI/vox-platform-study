# TASK-328 — Phase 2: Administration Completeness

| | |
|---|---|
| Ticket Number | TASK-328 |
| Short name | Admin-Console-Administration-Completeness |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Pending` |
| Type | feature |
| Scope | `apps/ui-playground/`, `apps/api/`, `packages/database/`, `packages/domains/`, `packages/applications/`, `@arcaai/vox` |
| Depends on | **TASK-326** (security) + **TASK-327** (scope shell) |

> Completes admin spec items **A4–A8** and the **A1–A3** tenant-detail gaps from TASK-325. Per **Q3**, new surfaces consume `@arcaai/vox` hooks (extend the SDK first where missing). Per **Q5**, the frontend pipeline is **typed JSON**.

---

## 1. Requirement Analysis

### 1.1 Acceptance criteria
- [ ] **A6 (X4)** — **Frontend** pipeline config as typed JSON: `TenantFrontendConfig` model (`asrModel`, `noiseCancel`, `vad`, `voiceEnrollment`, `diarization`, `configJson`) + `GET/PUT /admin/tenant/frontend-config` + a "Frontend Pipeline" tab. **Backend** pipeline gains per-tenant **default** assignment + `AsrPipelineVersion` history + enable/disable toggle.
- [ ] **A4** — Prompt **quality/score testing**: `lastTestScore/Output/At` fields + `POST /admin/prompt-templates/:id/test` (SMR-scored) + a Test panel; usage analytics grouped by dept/user/time (`GROUP BY` on `PromptUsageRecord`); diff includes `variables`; pagination pushed to the repository; remove dead `PRE_SUMMARY` client enum.
- [ ] **A5** — DNA **aggregate dashboard**: `GET /admin/dna-writing-styles/dashboard?tenantId=` (`usersWithStyle`, `avgVersions`, `recentActivity` from `DnaUsageRecord`) → Stat strip + chart above the existing browser.
- [ ] **A7** — Storage: wire delete file/bucket (with confirm dialogs); access-key UI (`StorageAccessKey`); provider/topology config UI (`tenant-storage-config-admin`); presigned download links.
- [ ] **A8** — Audit: date-range/action/resource filters; responsible-user column; before/after `data` detail drawer; CSV export endpoint.
- [ ] **A1–A3** — Tenant-detail completeness: Prompt-Templates + tenant-scoped Storage tabs; voice-profile + DNA + all-namespace settings sections in `UserDetailDialog`; `UserDepartment` join model + assignment endpoints; "manage selected tenant as tenant admin" CTA.
- [ ] Skeleton/empty/toast per rules `10`/`11`; OCC (`If-Match`) on all mutations; gates green (§4).

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
> Not started.

---

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 2). Scope = A4–A8 + A1–A3 tenant-detail; Q3 SDK-first, Q5 typed-JSON frontend config. Status `Pending`. | this README |
