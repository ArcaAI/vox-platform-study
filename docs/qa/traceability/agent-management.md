> _Relocated from `docs/implementation/TASK-382-Agent-Management/TRACEABILITY-MATRIX.md` (TASK-385 docs alignment)._

# TASK-382 — Agent Management Traceability Matrix (frames 30–33 + dialog)

> **What this is:** the row-level **use-case → design frame → backend API (`file:line`) → test → status**
> map for the department-scoped agent surface. It is the deep, testable view of TASK-371 rows
> **A1–A5** (`Agent instructions / prompts`) and **D3** (`Default agents per dept`).
>
> Mirrors [`TASK-371-Admin-Console-Redesign/TRACEABILITY-MATRIX.md`](./README.md):
> same legend + columns. `file:line` refs verified live against `apps/api` / `packages/applications` /
> `packages/agentic-sdk-v2` on 2026-06-30.

| | |
|---|---|
| **Ticket** | TASK-382 |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Frames 30–33 mapped; backend contract E2E added; **AG-W slot-assign contract gap RESOLVED + live-validated** (SDK sends `expectedVersion` + the column key → backend 200, OCC reached) |
| **Sources** | Designs = `HOPE-Admin-Console` frames 30/31/32/33 + `Dlg · New Agent Instruction`; Code = `apps/admin/src/{routes/.../agents,features/agents}`; API = `apps/api` + `packages/applications`; SDK = `packages/agentic-sdk-v2`; Tests = `apps/api/tests/e2e`, `apps/admin/e2e`, `features/agents/__tests__` |

## Legend

| Symbol | Meaning |
|---|---|
| 🟢 | **Built & automated-tested** end-to-end |
| 🟡 | **Built, partial test** — code exists but only negative/RBAC E2E, frontend-unit (mocked), client-side-only, or manual coverage |
| 🔴 | **Gap** — designed/built but **no backend endpoint**, a **contract mismatch**, and/or **no test** |
| 🎯 | **Target** — design-only flow with no backing column/field yet (intentional, README §1.3) |
| 🔒 | endpoint is strictly super-admin-only |

**Conventions (apply to every API cell):**

- All paths are under the global prefix **`/api/v1`** (`apps/api/src/main.ts:66`).
- Admin prompt routes are class-guarded `@Authorize(['manage','PromptTemplate'])` (`prompt-management.controller.ts:38`);
  department routes are `@CanManage('Department')` (`department.controller.ts:22`). `TENANT_ADMIN` holds both
  abilities tenant-scoped (`seed/03-role.ts`), so the surface is **not** super-admin-only.
- The global `ValidationPipe` runs `whitelist + forbidNonWhitelisted` (`main.ts:124`) — unknown body keys → **400**.
- OCC writes require RFC 7232 `If-Match: "<version>"`: missing → **428** (`HTTP.PRECONDITION_REQUIRED`),
  drift → **412** (`PERSISTENCE.CONCURRENCY_CONFLICT`).

## Coverage snapshot

- **14 use cases** mapped across frames 30–33 + the create dialog.
- **Backend present** for all REAL flows; the new `apps/api/tests/e2e/task-382-agent-management.spec.ts` adds the
  **first backend E2E** for create / list / update-OCC / versions / activate / test-OCC / prompt-config / assign — upgrading
  TASK-371 A1/A2/A4/A5 + D3 from 🔴/🟡 *(no backend E2E)* toward 🟢/🟡.
- **AG-W slot-assign write path — RESOLVED + live-validated:** the SDK `assignToDepartment` now translates the
  ergonomic `{ promptTemplateId, field }` into the backend column key and sends `expectedVersion`
  (`usePrompts.ts:173-177`), so the body matches the whitelisted `AssignDepartmentPromptRequest`
  (`{ departmentId, preSummaryPromptId?, newPatientPromptId?, revisitPromptId?, expectedVersion }`) → **200** with the
  Department OCC write reached (428 missing / 412 stale). Pinned by the backend spec (correct shape → 200; OCC) and the
  admin call site threading `department.version` through `slotAssignInput` (`agents/.../index.tsx:74-79`).
- **2 🎯 targets** (unchanged, never fabricated): DNA writing-style default slot; test sub-metrics as a UI feature
  (the backend `metrics` exists but the SDK type omits it — see AG13).
- `compareVersions` remains **client-side** (no server diff endpoint) — A3 stays 🟡.

---

# Frames 30–33 · Agent instructions / prompts

## 30 · Agent Management (slots + library) — `120:9200`

| ID | Use case | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| AG1 | Agent management by department — slots + library shell (US 45–52) | `30 · Agent Management` `120:9200` (in `36p` shell `110:7414`) | composite of AG2/AG3/AG-W below; `GET /admin/departments/:id` `department.controller.ts:77` | FE nav `apps/admin/e2e/task-382-agent-management.spec.ts` (slots+library render); cross-link **A1** | 🟡 |
| AG2 | Instruction **library** — list by department (`scope=DEPARTMENT_DEFAULT`) | `30` lower half | `GET /admin/prompt-templates?departmentId=` `prompt-management.controller.ts:66` → `listPromptTemplatesPaginated` | `task-382-agent-management.spec.ts` (be: list contains created prompt; fe: library list/empty) ; cross-link **A1** | 🟢 |
| AG3 | Default slot **read/resolve** — pre-summary / new-visit / re-visit | `30` slot cards | `Department.preSummaryPromptId / newPatientPromptId / revisitPromptId` on `GET …/departments/:id :77`; resolved by `features/agents/slot-config.ts:70` | `features/agents/__tests__/slot-config.test.ts` (resolve REAL; DNA TARGET=null) | 🟢 |
| AG-W | Default slot **write/assign** — wire a prompt into a slot | `30` `Assign`/`Change` → `AssignSlotDialog` `110:8440`-adjacent | **all three REAL slots** route through `usePrompts.assignToDepartment` → `POST /admin/prompt-templates/assign-department` `prompt-management.controller.ts:282`, which delegates to `departmentService.updatePromptConfig` (OCC). The SDK now translates `{promptTemplateId, field}` → `{[field]: promptTemplateId, expectedVersion}` `usePrompts.ts:173-177` ← `slot-config.ts:83-91` (carries `expectedVersion`); the DTO whitelists `{departmentId, preSummaryPromptId?, newPatientPromptId?, revisitPromptId?, expectedVersion!}` `assign-department-prompt.request.ts:4-35` and the service forwards **all three** slot fields `prompt-management.service.ts:646-657` → **200** (OCC reached; 428 missing / 412 stale). Pre-summary is settable here too (DTO + service accept `preSummaryPromptId`). | `task-382-agent-management.spec.ts` (be: assign-department correct shape → 200; prompt-config 428/200; OCC) | 🟢 |
| AG4 | New instruction (create) dialog | `Dlg · New Agent Instruction` `110:8440` | `POST /admin/prompt-templates` `prompt-management.controller.ts:51` → `createPromptTemplate` | `task-382-agent-management.spec.ts` (be: create→201 DEPARTMENT_DEFAULT, departmentId wired); cross-link **A2** | 🟢 |

## 31 · Instruction Editor — `120:9454`

| ID | Use case | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| AG5 | Edit content + `{{variables}}` → save new version (OCC) | `31 · Instruction Editor` `120:9454` | `PATCH /admin/prompt-templates/:id` `prompt-management.controller.ts:145` (`@RequiresIfMatch` :123) → `updatePromptTemplate` | `task-382-agent-management.spec.ts` (be: 428 no-header · 412 stale · 200 valid + `currentVersionNumber` bump); `features/agents/__tests__/instruction-draft.test.ts`; cross-link **A2** | 🟢 |
| AG6 | Version rail history | `31` version rail | `GET /admin/prompt-templates/:id/versions` `prompt-management.controller.ts:178` | `task-382-agent-management.spec.ts` (be: ≥2 versions after edit, v1 retained) | 🟢 |
| AG7 | Draft / Publish lifecycle | `31` Save draft / Publish | `PromptTemplate.status` via create (:51) / update (:145) | `task-382-agent-management.spec.ts` (be: create PUBLISHED; update status); `instruction-draft.test.ts` (`promptStatusRole`) | 🟢 |

## 32 · Version Diff — `120:9567`

| ID | Use case | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| AG8 | Side-by-side version diff (content + variables) | `32 · Version Diff` `120:9567` | 🔴 **no server diff endpoint** — SDK `compareVersions` GETs both versions (`prompt-management.controller.ts:190`) and diffs **client-side** (`usePrompts.ts:171` → `computePromptDiff`) | `task-382-agent-management.spec.ts` (be: both version GETs resolve, contents differ); `features/agents/__tests__/diff-model.test.ts`; cross-link **A3** | 🟡 (client-side) |
| AG9 | Rollback / activate a version | `32` Activate / Roll back | `POST /admin/prompt-templates/:id/versions/:n/activate` `prompt-management.controller.ts:259` (server reads current `version` → CAS) | `task-382-agent-management.spec.ts` (be: activate v1 restores original content); `features/agents/__tests__` (mocked); cross-link **A4** | 🟢 |

## 33 · Test Playground — `120:9681`

| ID | Use case | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| AG10 | Run instruction → score + output (OCC write) | `33 · Test Playground` `120:9681` | `POST /admin/prompt-templates/:id/test` `prompt-management.controller.ts:236` (`@RequiresIfMatch` :217) → `testPromptTemplate` (SMR) | `task-382-agent-management.spec.ts` (be: 428 no-header deterministically; 200 score∈[0,1]+output when SMR up — else noted); `playground-format.test.ts`; cross-link **A5** | 🟡 (OCC tested · SMR run env-dependent) |
| AG11 | Headline score (quality proxy) | `33` Evaluation block | `PromptTestResultResponse.score` `prompt-test-result.response.ts:32` | `task-382-agent-management.spec.ts` (be, on 200); `playground-format.test.ts` (`scoreToneRole` thresholds) | 🟡 |
| AG12 | Test **sub-metrics** breakdown (faithfulness/coverage/conciseness) | `33` per-dimension bars | ⚠️ backend `PromptTestResultResponse.metrics?` **exists** (deterministic F8) `prompt-test-result.response.ts:45`, but the SDK `PromptTestResult` type **omits** it (`types/prompt.ts:159`) and the admin expects `Record<string,number>` (≠ `PromptTestMetrics`) → rendered only if present, framed as a proxy | `task-382-agent-management.spec.ts` (be: asserts `metrics` shape **iff** returned); cross-link **A5** | 🟡 · 🎯 |

## Cross-cutting

| ID | Use case | Design (frame · node) | Backend API (`/api/v1…` · file:line) | Test | Status |
|---|---|---|---|---|---|
| AG13 | **DNA writing-style** default slot (per dept) | `30` 4th slot card | 🔴 **no `dnaWritingStylePromptId` column** — drawn + flagged `hope`/Target, never wired (`slot-config.ts:51`, `target:true :55`) | `slot-config.test.ts` (TARGET → `slotAssignInput` null); cross-link **D3 / U10** | 🎯 |
| AG14 | Tenant isolation (404-over-403) | n/a (security invariant) | repo tenant-scope on `GET …/prompt-templates/:id` `prompt-management.controller.ts:110` (throws `NotFound`) | `task-382-agent-management.spec.ts` (be: `tenant_admin`@`__GLOBAL__` reads an ARCAAI prompt → 404) | 🟢 |

---

## Cross-links to the TASK-371 matrix

| TASK-371 row | Was | Now (with TASK-382) |
|---|---|---|
| **A1** Agent management + default slots | 🔴 *no backend; frontend-unit only* | **AG1/AG2/AG-W** — backend E2E added; library list 🟢; **slot-assign write 🟢** (AG-W contract gap resolved — SDK sends `expectedVersion`) |
| **A2** Create / edit instruction | 🔴 | **AG4/AG5** — create + update-OCC backend E2E → 🟢 |
| **A3** Version diff / compare | 🔴 | **AG8** — confirmed **client-side** (no endpoint); building-block version GETs tested → 🟡 |
| **A4** Version rollback / activate | 🟡 *(mocked)* | **AG9** — activate backend E2E (content rollback) → 🟢 |
| **A5** Test playground / evaluate | 🟡 · 🎯 | **AG10/AG11/AG12** — OCC gate tested; score 🟡; sub-metrics 🟡·🎯 (backend `metrics` exists, SDK omits) |
| **D3** Default agents per dept | 🟡 · 🎯 | **AG3** read 🟢; **AG-W** write 🟢; **AG13** DNA 🎯 |

## Backlog rollup (gaps → tickets)

**Contract / SDK — RESOLVED (landed; reconciled 2026-07-01)**
1. ~~**Slot-assign body mismatch (AG-W)**~~ — **RESOLVED.** The SDK `assignToDepartment` now translates
   `{promptTemplateId, field}` → `{[field]: promptTemplateId, expectedVersion}` (`usePrompts.ts:173-177`) and the
   admin call site threads `department.version` (`agents/.../index.tsx:74-79`), so the body matches the whitelisted
   DTO → **200** with the Department OCC write reached.
2. ~~**`preSummaryPromptId` via `assign-department`**~~ — **RESOLVED.** The DTO whitelists `preSummaryPromptId?`
   (`assign-department-prompt.request.ts:9-12`) and the service forwards it via `updatePromptConfig`
   (`prompt-management.service.ts:646-657`), so the pre-summary slot is now reachable from frame 30 too.

**Backend — missing endpoints (inherited from TASK-371)**
3. **Prompt `compareVersions` (AG8 / A3)** — a server diff endpoint backing `32 · Version Diff` (today client-side).
4. **Per-dept DNA-style default agent (AG13 / D3 / U10)** — `dnaWritingStylePromptId` column / `promptConfig` key.

**Frontend / SDK alignment**
5. **Test sub-metrics (AG12 / A5)** — surface the backend `PromptTestResultResponse.metrics` on the SDK
   `PromptTestResult` type and map `PromptTestMetrics` (booleans/nulls) to the admin's display shape.

**Test — run-pending**
6. The backend spec asserts the deterministic OCC contract everywhere; the **SMR-dependent** test-run assertion
   (AG10) and the full FE journey run only against a seeded stack (`pnpm test:e2e` / admin Playwright webServer).
