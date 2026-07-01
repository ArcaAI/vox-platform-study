# TASK-382 — Agent Management by Department (frames 30–33)

| | |
|---|---|
| **Ticket** | TASK-382 |
| **Type** | Feature (admin app — design-approved build) |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Review — design / traceability / E2E artifacts added; **AG-W contract gap RESOLVED + live-validated** (slot-assign now sends `expectedVersion` → backend 200, OCC reached) |
| **App** | `apps/admin` only (no `packages/ui` / SDK changes) |
| **Design** | `HOPE-Admin-Console` frames **30** `120:9200` · **31** `120:9454` · **32** `120:9567` · **33** `120:9681` + `Dlg · New Agent Instruction` `110:8440` |
| **References** | [TASK-371 README §5.14 / §5.14.1](../TASK-371-Admin-Console-Redesign/README.md) · [PHASE-3-PLAN §1 #3 / §2 / §3](../TASK-371-Admin-Console-Redesign/PHASE-3-PLAN.md) · [TRACEABILITY-MATRIX A1–A5, D3](../TASK-371-Admin-Console-Redesign/TRACEABILITY-MATRIX.md) |
| **Companion artifacts** | [`DESIGN-SPEC.md`](../../designs/admin/agent-management.md) · [`TRACEABILITY-MATRIX.md`](../../qa/traceability/agent-management.md) · [`MANUAL-E2E-TESTS.md`](../../qa/manual-tests/07-agent-management.md) · backend E2E `apps/api/tests/e2e/task-382-agent-management.spec.ts` · frontend E2E `apps/admin/e2e/task-382-agent-management.spec.ts` |

> Deepens the **Department Detail “Agent instructions” sub-tab** into a gold-standard,
> department-organized agent surface: **default-agent slots** + **instruction library**
> (30), full-page **editor** (31), **version diff** (32), and a **test playground** (33).
> Improves on the old `apps/ui-playground` prompt UI (department-organized, semantic
> tokens only, full-page editor, real playground) per PHASE-3-PLAN §3.

---

## 1. Requirement Analysis

### 1.1 Description

“Agent instruction” is a UI label over a department-scoped `PromptTemplate`
(`scope = DEPARTMENT_DEFAULT`). A department wires **default agents** through its
prompt-config fields. The surface must let an operator: see which prompt is the live
default for each slot, browse/edit the department instruction library, version & diff &
roll back, and validate a draft in a sandbox playground before publishing.

### 1.2 Frames → scope

| Frame | Surface | Route |
|---|---|---|
| **30** Agent Management (by dept) | 4 default-agent slot cards + instruction library | `…/departments/$departmentId/agents` |
| **31** Instruction Editor | mono `content` editor, `{{variable}}` chips, metadata, save-new-version / publish, version rail + activate | `…/agents/$promptId` (Editor) |
| **32** Version Diff | side-by-side two-version diff (content+variables) + activate/rollback | `…/agents/$promptId/diff` |
| **33** Test Playground | variable inputs → Run → quality-proxy score + metrics + output | `…/agents/$promptId/playground` |

### 1.3 REAL vs TARGET (do NOT fabricate — PHASE-3-PLAN §3 #3, matrix A1–A5/D3)

| Feature | Status | Backing |
|---|---|---|
| List instructions by department | **REAL** | `usePrompts.list({ departmentId })` (`scope=DEPARTMENT_DEFAULT`) |
| Default slots **read/resolve**: pre-summary / new-visit / re-visit | **REAL** | resolved from `Department.preSummaryPromptId / newPatientPromptId / revisitPromptId` |
| Default slots **write/assign** | **✅ REAL (AG-W resolved)** | the SDK `assignToDepartment` now translates `{promptTemplateId, field}` → `{[field]: promptTemplateId, expectedVersion}` (`usePrompts.ts:173-177`) and the admin threads `department.version`, so the body matches the whitelisted `AssignDepartmentPromptRequest` → backend **200** (Department OCC write; 428/412 on missing/stale token). The DTO + service now accept + forward `preSummaryPromptId` too, so all three REAL slots wire from frame 30. See [TRACEABILITY-MATRIX **AG-W**](../../qa/traceability/agent-management.md). |
| **Default slot: DNA writing-style (per dept)** | **🎯 TARGET** | no `dnaWritingStylePromptId` column → drawn + flagged, no wiring |
| Versions / diff | **REAL** | `usePrompts.getVersions`; `usePrompts.compareVersions` is **client-side** (GETs both versions → `computePromptDiff`; no server diff endpoint — matrix **AG8**) |
| Editor create/update (variables, changeReason) | **REAL** | `usePrompts.create` (reused create dialog) · `usePrompts.update` (OCC `If-Match`) |
| Rollback (activate version) | **REAL** | `usePrompts.activateVersion` |
| Test playground (score + output) | **REAL** | `usePrompts.test` → `{ score, output, testedAt, version }` (OCC `If-Match`) |
| Test sub-metrics (faithfulness/coverage/conciseness) | **🎯 TARGET** | the **backend** `PromptTestResultResponse.metrics?` exists (TASK-331 doc-02 F8), but the SDK `PromptTestResult` type **omits** it and the admin expects a different shape → rendered only if returned, framed as an honest “proxy” (matrix **AG12**) |
| Draft / Publish | **REAL** | `PromptTemplate.status` |

---

## 2. Implementation Plan

### 2.1 Route restructure (exclusive ownership)

`tenants/$tenantId/departments/$departmentId.tsx` → directory:

```
$departmentId/
  route.tsx                 # layout: fetch dept → store (breadcrumb) → <Outlet/>; loading/404
  index.tsx                 # Members tab (migrated verbatim)
  agents/
    route.tsx               # pathless <Outlet/>
    index.tsx               # 30 · Agent Management (slots + library)
    $promptId/
      route.tsx             # instruction workspace: header + Editor/History/Playground sub-tabs
      index.tsx             # 31 · Editor
      diff.tsx              # 32 · Version Diff
      playground.tsx        # 33 · Test Playground
```

Breadcrumb: dept detail ends at `… / Departments / Cardiology` (sub-tab shown by nav,
not appended); instruction workspace extends `… / Cardiology / Agent instructions / «mode»`.

### 2.2 Pure logic — `features/agents/*` (TDD-first, vitest)

| File | Responsibility |
|---|---|
| `slot-config.ts` | slot ↔ `Department` prompt-config mapper: `DEFAULT_AGENT_SLOTS`, `resolveSlotAssignments`, `slotAssignInput` |
| `instruction-draft.ts` | `parseVariableNames` (`{{var}}`), `toPromptVariables`, `toUpdatePromptInput` (changeReason/expectedVersion), `promptStatusRole/Label`, `categoryLabel` |
| `diff-model.ts` | `DiffResult` → side-by-side `{ left, right }` columns + `summarizeDiff` (token-toned add/remove) |
| `playground-format.ts` | `formatScore`, `scoreToneRole`, `scorePercent`, `normalizeMetrics`, `resolveTestVariables` |
| OCC | **reuse** `features/common/occ.ts` `reduceOccConflict` (already tested) |

### 2.3 TDD test list

- **slot-config**: 3 REAL slots resolve to their wired prompt; DNA slot is TARGET (no field → null, `slotAssignInput` returns null); unassigned/missing prompt → null; REAL `slotAssignInput` builds `{departmentId,promptTemplateId,field}`.
- **instruction-draft**: `parseVariableNames` extracts unique `{{vars}}` in first-seen order, trims, ignores malformed/empty; `toPromptVariables` → required string vars; `toUpdatePromptInput` trims content, carries status/changeReason/expectedVersion/derived variables; `promptStatusRole` PUBLISHED→success else neutral; `categoryLabel` maps enum.
- **diff-model**: removed→left numbered + right empty; added→right numbered + left empty; unchanged→both context; `summarizeDiff` returns stats; empty changes → empty columns.
- **playground-format**: `formatScore` null→“—”, rounds to 2dp; `scoreToneRole` thresholds (≥.85 success / ≥.6 warning / else destructive / null neutral); `normalizeMetrics` sorts + handles empty; `resolveTestVariables` filters empty values.

### 2.4 Components — `features/agents/*`

`department-shell` (dept header + Members/Agent-instructions sub-tabs), `default-agent-slots`,
`instruction-library` (ItemList), `assign-slot-dialog` (single-select), `instruction-workspace`
(instruction header + Editor/History/Playground tabs), `instruction-editor`, `version-diff`,
`test-playground`. Semantic tokens only; dot+label status; tabular-nums; font-mono for
content/scope/IDs; ≥44px targets; loading/empty/error/selected; responsive. Create entry =
reuse existing `features/tenants/agent-instruction-dialog` (composed read-only, not edited).

---

## 3. Implementation Summary

The flat `departments/$departmentId.tsx` was restructured into the directory in §2.1 and the
pre-built `features/agents/*` logic + components were composed into the agent surface
(frames 30–33).

**Route restructure** — `$departmentId/route.tsx` is the layout (fetches the department →
publishes to the tenant-detail store → gates loading/404 → `<Outlet/>`); `index.tsx` is the
**Members** tab (migrated verbatim into `DepartmentDetailShell`); `agents/route.tsx` is a
pathless outlet; `agents/index.tsx` is **frame 30**; and `agents/$promptId/` is the
instruction workspace (`route.tsx` fetches prompt + versions into a context and gates load;
`index.tsx` / `diff.tsx` / `playground.tsx` are the Editor / Version-diff / Playground
leaves). The department crumb ends at `… / Departments / «dept»`; the workspace appends a
single `Agent instructions` crumb (mode shown by the workspace tabs, not the breadcrumb).

- **Frame 30** (`agents/index.tsx`): `DefaultAgentSlots` (the 3 REAL summary slots resolved
  via `resolveSlotAssignments` from `Department.preSummaryPromptId / newPatientPromptId /
  revisitPromptId`, plus the **DNA writing-style TARGET** slot — drawn, flagged, never
  wired) + `InstructionLibrary` (`usePrompts.list({ departmentId })`, sorted by last
  updated). Slot wiring uses `AssignSlotDialog` → `slotAssignInput` → `usePrompts.assignToDepartment`
  with OCC handling; **New instruction** reuses the existing `agent-instruction-dialog`
  (composed read-only) → `usePrompts.create`.
- **Frame 31** (`agents/$promptId/index.tsx`): `InstructionEditor` with live `{{variable}}`
  parsing, locked metadata, the change-reason field, and the version rail; **Save draft** /
  **Publish version** in the workspace header map to `usePrompts.update` (status DRAFT /
  PUBLISHED) via `toUpdatePromptInput` (carries `expectedVersion` OCC token); version-rail
  **Activate** → `usePrompts.activateVersion`.
- **Frame 32** (`diff.tsx`): `VersionDiff` driven by `usePrompts.compareVersions` →
  `DiffResult` adapted by `toDiffColumns`/`summarizeDiff` (token-toned ± lines); **Roll back
  to v«base»** / **Activate v«compare»** header actions → `usePrompts.activateVersion`.
- **Frame 33** (`playground.tsx` + new `test-playground.tsx`): variable inputs + sample
  input → **Run test** → `usePrompts.test` → REAL headline `score` (SMR quality proxy) with
  a token-toned meter and output; the per-metric breakdown renders only if a future backend
  returns a `metrics` map, otherwise framed honestly as a proxy (**TARGET**).

### Files changed

| File | Change |
|---|---|
| `routes/.../departments/$departmentId.tsx` | **Deleted** (replaced by the directory below). |
| `…/$departmentId/{route,index}.tsx` | New department layout + Members tab. |
| `…/$departmentId/agents/{route,index}.tsx` | New pathless outlet + frame 30. |
| `…/$departmentId/agents/$promptId/{route,index,diff,playground}.tsx` | New workspace layout + frames 31/32/33. |
| `features/agents/test-playground.tsx` | New presentational playground body (frame 33). |
| `features/agents/sdk-types.ts` | New — thin **re-export** of `PromptTemplateStatus` / `DepartmentPromptField` / `PromptTestResult` from `@arcaai/vox` (stabilizes import path; see deviation). |
| `features/agents/{instruction-draft.ts, slot-config.ts}` | Re-pointed those type imports to `./sdk-types` (no logic change). |

### Deviations

- **SDK type re-export (no SDK edit)** — `features/agents/sdk-types.ts` is a thin
  **re-export** of `DepartmentPromptField` / `PromptTemplateStatus` / `PromptTestResult` from
  `@arcaai/vox`, kept only to stabilize the import path for existing call sites. *(Plan-review
  correction 2026-06-30: the public barrel `core.ts` **does** export all three — `:325/:329/:330`
  — so the earlier "omitted/derived" note was stale; the file is a passthrough, not a derivation.)*
- **Frame 30 is department-scoped** — per §2.1 the approved plan localizes the Figma frame-30
  "department rail" into the Department-detail **Agent instructions** sub-tab
  (`…/departments/$departmentId/agents`), matching every pre-built component
  (`DepartmentDetailShell`, `InstructionWorkspaceShell` back-link, slot resolver).
- **REAL/TARGET** honored: DNA writing-style default slot and the test sub-metrics remain
  TARGET (no backing column/field — drawn/flagged, never fabricated).

## 4. Verification

All five gates were run once from the repo root (zsh) after every edit across TASK-380/381/382.

Agent logic suite (`features/agents`):

```
$ pnpm --filter @arcaai/admin exec vitest run src/features/agents
 Test Files  4 passed (4)
      Tests  27 passed (27)
```

Full admin gates:

```
$ pnpm --filter @arcaai/admin generate-routes   # tsr generate → exit 0
$ pnpm --filter @arcaai/admin type-check         # tsc --noEmit → exit 0 (no errors)
$ pnpm --filter @arcaai/admin test
 Test Files  25 passed (25)
      Tests  184 passed (184)
$ pnpm --filter @arcaai/admin lint               # ✖ 9109 problems (0 errors, 9109 warnings) → exit 0
$ pnpm --filter @arcaai/admin build              # ✓ built in 9.70s → exit 0
```

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-30 | Ticket created; plan + TDD list for agent management (frames 30–33). | `README.md` |
| 2026-06-30 | Restructured `$departmentId.tsx` → agents subtree; composed `features/agents/*`; built `test-playground.tsx` + `sdk-types.ts` (SDK-safe type derivation). All 5 admin gates green (27 agent tests, 184 total). Status → Review. | `$departmentId/**`, `features/agents/{test-playground,sdk-types,instruction-draft,slot-config}.*`, `README.md` |
| 2026-06-30 | **Doc + test review pass.** Added `DESIGN-SPEC.md` (frames 30–33 + dialog, D/T/M), `TRACEABILITY-MATRIX.md` (AG1–AG14, verified backend `file:line`, cross-linked A1–A5/D3), `MANUAL-E2E-TESTS.md` (persona suite, X-principles), backend + frontend E2E specs. **Plan-review corrections:** (a) `sdk-types.ts` is a thin **re-export** (barrel exports all three types — earlier "omitted/derived" note was stale); (b) default-slot **write** is a **🔴 contract gap** (AG-W) — SDK body `{…,field}` (no `expectedVersion`) is rejected 400, so OCC is never reached; (c) `compareVersions` noted **client-side**; (d) backend `PromptTestResultResponse.metrics` exists but SDK omits it (sub-metrics stay TARGET). | `DESIGN-SPEC.md`, `TRACEABILITY-MATRIX.md`, `MANUAL-E2E-TESTS.md`, `apps/api/tests/e2e/task-382-agent-management.spec.ts`, `apps/admin/e2e/task-382-agent-management.spec.ts`, `README.md` |
| 2026-06-30 | **🔴 AG-W contract gap RESOLVED + live-validated.** Aligned the SDK to the backend contract: `usePrompts.assignToDepartment` now translates the ergonomic `{promptTemplateId, field}` → `{[field]: promptTemplateId, expectedVersion}`; added `expectedVersion` to `AssignDepartmentPromptInput`; admin call site threads `department.version` through `slotAssignInput`. Backend DTO/service now whitelist + forward `preSummaryPromptId`. SDK + admin unit suites updated & green; **live backend E2E `task-382` passes** (correct shape → 200, OCC reached). Spec fix: relaxed the server-derived `prompt.scope` assertion. | `packages/agentic-sdk-v2/src/types/prompt.ts`, `packages/agentic-sdk-v2/src/hooks/usePrompts.ts`, `apps/admin/src/features/agents/slot-config.ts`, `apps/admin/src/routes/_authenticated/tenants/$tenantId/departments/$departmentId/agents/index.tsx`, `packages/applications/src/services/prompt-management/{dto/assign-department-prompt.request.ts,prompt-management.service.ts}`, `apps/api/tests/e2e/task-382-agent-management.spec.ts` |
| 2026-07-01 | **QA-doc reconciliation (docs only — no code touched).** Brought the stale QA docs in line with the landed AG-W fix (verified live: `usePrompts.ts:173-177`, `assign-department-prompt.request.ts:9-12`, `prompt-management.service.ts:646-657`): flipped **AG-W 🔴 → 🟢** in [`traceability/agent-management.md`](../../qa/traceability/agent-management.md) (status, coverage snapshot, AG-W row, A1/D3 cross-links, backlog items 1–2 marked resolved); updated [`manual-tests/07`](../../qa/manual-tests/07-agent-management.md) `T382-A.slot.1/.2` from "expect 400 / log a defect" → **expect 200 success** (pre-summary settable via `assign-department` too); fixed the residual stale §1.3 feature-table cell here (`🔴 CONTRACT GAP` → `✅ REAL`). *(Note: backend spec `task-382` still keeps a defensive test that the **raw** `{promptTemplateId, field}` shape 400s — true, but the SDK no longer posts that shape; its "end-to-end break" comment is now stale — flagged for the test owner.)* | `docs/qa/traceability/agent-management.md`, `docs/qa/manual-tests/07-agent-management.md`, `README.md` |
