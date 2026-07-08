# TASK-441 — Tenant Resource Pages Redesign: One Shared Frame, Slide-Over Detail, 3-Pane Hierarchy

- **Status**: Review
- **Type**: feature (UX/UI redesign — six tenant-scoped pages)
- **Owner**: admin-console
- **Design source**: project "ARCAAI Hope Admin console" (`https://claude.ai/design/p/6a582386-939b-47d3-8c19-cd9338b34814`) — build spec §7; artboards `3c` (Departments 3-pane), `3d`–`3i` (per-page), `5e` (mobile drill-down).
- **Related**: **depends on TASK-437** (DetailDrawer, TenantScopeBanner, viewport tiers); TASK-423 (grid), TASK-427 (ScreenTemplate).

## Requirement Analysis

Six pages share one frame (§3 region contract): tenant banner · header · toolbar · content · status footer. Interaction pattern: **grid + slide-over** by default; **3-pane** (tree · items · editor) for hierarchical pages.

| Page | Route | Pattern | Key columns / panes |
|---|---|---|---|
| Departments | `/departments` | 3-pane | tree → members → prompt config |
| Storage browser | `/storage` | grid + breadcrumb | name · type · size · modified |
| Agents & prompt templates | `/agents` | grid + slide-over | name · dept · type · status · usage |
| DNA writing styles | `/dna-writing-styles` | grid | doctor · version · status · updated |
| Audio pipelines | `/audio/pipelines` | master–detail | engine · default · on/off/suspended |
| Harness workflows | `/harness/workflows` | grid (live) | type · run-state · started |

- All carry the "Acting on {tenant}" banner (statusBanner slot) and a status footer with the page's GET endpoint. Status badges use the status token set (running=info, ok=success, failed=destructive, suspended=warning) — never color-only.
- **Departments 3-pane**: left department tree (divisions → departments, counts); center members list (role chips, lead); right prompt config (default agent select + tone override). Tablet: tree → drawer. Mobile (5e): drill-down tree ▸ members ▸ editor with back nav; editor opens as a sheet.
- Endpoints marked *representative* in the spec — **confirmed against each feature's `api/client.ts` below; the existing clients are authoritative and unchanged.**

### Acceptance criteria (spec §7)

- [x] All six render the shared frame (header · toolbar · content · footer). **Banner decision (2026-07-08): kept the GLOBAL "Acting on {tenant}" banner only — no per-page `TenantScopeBanner` added** (the TASK-437 suppression mechanism the plan assumed does not exist; a per-page banner would double-render). The banner requirement is satisfied globally by `(console)/layout.tsx` → `WorkingTenantBanner`.
- [x] One shared detail surface — the console-wide `DetailDrawer` (right slide-over → mobile full-screen sheet). Bespoke record modals retired: `template-form-dialog` (Agents create/edit), `CreatePipelineDialog`, `CreateDepartmentDialog` + `DepartmentEditPanel` inline edit, `doctor-detail-panel`, `bucket-list-card`/`ObjectActionsPanel` rail, and the harness `signals-lifecycle-panel` Card all removed or folded into drawers.
- [x] Empty / loading / error states present per page (unchanged from the prior screens); **Harness now polls** (`refetchInterval` 5s while any run is `RUNNING`, paused on hidden tab) to reflect run-state live.
- [x] 3-pane (Departments) collapses at tablet/mobile via `useViewportTier` (compact stacks members + prompt-config, tree behind a toggle sheet). Grid-primary pages get their mobile full-screen sheet automatically from `DetailDrawer`.

## Current State Evaluation

Verified 2026-07-08. Common: all six are client screens in `ScreenTemplate` (**all `contentMode='scroll'`**, none use `statusBanner`/`fill`), wrapped in `WorkingTenantGate`, with `PageHeader` + `StatusFooter` endpoint hints. The "Acting on" banner is **global** (`(console)/layout.tsx` → `WorkingTenantBanner`), not per-page. Detail/edit everywhere = **inline master-detail card columns + modal dialogs** — no slide-overs.

| Page | Screen file (`features/…`) | Today | Main deltas |
|---|---|---|---|
| Departments | `departments/components/departments-screen.tsx` | Already 3-panel grid: `DepartmentHierarchyPanel` (roots + lazy children) / `DepartmentMembersPanel` / `DepartmentEditPanel` (If-Match PATCH + prompt-config). Custom toolbar (nuqs `q`, include-disabled switch). Create dialog. Selection `?dept=`. | Closest to target. Right pane refocuses on **prompt config** (default agent select + tone override — `PATCH /:id/prompt-config` exists); dept edit moves to slide-over; responsive collapse missing. |
| Storage browser | `storage-browser/components/storage-browser-screen.tsx` | 3-column cards: `BucketListCard` / `ObjectBrowserPanel` (client-derived folders, embedded grid) / `ObjectActionsPanel`. FilterBar. URL `bucket/prefix/search`. | Move to grid + **breadcrumb** path bar (name·type·size·modified columns); object actions → slide-over; bucket list → toolbar select or left rail per artboard 3e. |
| Agents | `agents/components/agents-screen.tsx` | 3-col: `VersionsPanel` / `VirtualizedDataGrid` (h=480) / `TestRunPanel`; create/edit modals (`template-form-dialog`); `?template=`. | Grid becomes fill-height primary; detail (overview·versions·test-run tabs) → slide-over; modals retired. |
| DNA styles | `dna-writing-styles/components/dna-writing-styles-screen.tsx` | 3-col: `DashboardCard` (SSE job progress + 2s poll fallback) / grid (h=480) / `DoctorDetailPanel`; `GenerateReportDialog`; `?selected=`. | Grid primary (doctor·version·status·updated); doctor detail + versions → slide-over; dashboard strip → `stats` slot; generate stays a short dialog (acceptable: confirmation-class). |
| Audio pipelines | `audio-pipelines/components/audio-pipelines-screen.tsx` | 3-col: `ConfigEditorCard` (YAML) / grid (h=480, client-side paging) / `VersionsLifecyclePanel` (isElevated-gated); create dialog; local selection. | Master–detail: grid + slide-over with tabs (Config YAML editor · Versions · Lifecycle); default/toggle/suspend badges per status tokens. |
| Harness workflows | `harness-ops/components/harness-workflows-screen.tsx` | 4-col: `WorkflowDetailDrawer` (a Card, not an overlay) / cursor-paginated grid / `SignalsLifecyclePanel`; FilterBar; **manual Refresh only — no polling**. | Grid primary (type·run-state·started); detail (phases · signals · cancel/terminate) → slide-over; **add polling** (`refetchInterval` while runs are non-terminal) for AC 3 "live". |

Shared infra relevant: `TenantScopeBanner` + `DetailDrawer` + `useViewportTier` arrive from TASK-437. `VirtualizedDataGrid` supports fill-height (TASK-427: fill = height omitted). OCC (`getWithEtag`/`patchWithEtag`) already used by departments/agents/dna/pipelines — unchanged.

## Implementation Plan

Strategy: **one enabling pass + six page migrations** run as independent sub-tasks (parallelizable after step 1), each TDD with its screen test updated first. No API client changes anywhere.

### 1. Frame conventions pass (all six, mechanical)

- Add `statusBanner={<TenantScopeBanner />}` to each screen; coordinate with the global `WorkingTenantBanner` per TASK-437 Task 3 (global banner stops rendering for routes carrying the page-level banner; final cleanup here).
- Switch grid-primary pages (agents, dna, pipelines, workflows, storage objects) to `contentMode="fill"` with the grid fill-height (remove fixed `height 480`), pagination pinned above the footer (grid built-in).
- Normalize `StatusFooter`: `start` = Up to date / Refreshing (query state), `end` = mono GET endpoint (already present).
- Status badge audit: map run/resource states to token set (running=info, ok=success, failed=destructive, suspended=warning) via the existing `StatusBadge`/`ResourceStatusBadge`.
- Tests: shared frame assertions added to each screen test (banner present, footer endpoint, fill mode where specified).

### 2. Departments — 3-pane target (artboard 3c)

- Keep tree/members structure; right pane becomes **Prompt config** card (default agent `Select` fed by agents catalog + tone override textarea → existing `PATCH /:id/prompt-config` If-Match flow); department create/edit moves to `DetailDrawer` (retiring inline `DepartmentEditPanel` edit + `CreateDepartmentDialog`).
- Members panel: role chips + lead marker (data already in `GET /:id/users`).
- Responsive: tablet — tree in a toggleable left Sheet; mobile — drill-down (tree ▸ members ▸ config) with back nav, config as sheet (5e). Driven by `useViewportTier`.
- Tests: pane wiring, prompt-config save (If-Match), drill-down navigation under mocked tiers.

### 3. Agents — grid + slide-over

- Fill-height grid (name · department · type · status · active · usage). Slide-over tabs: **Overview** (edit form, OCC), **Versions** (`VersionsPanel` content + activate/diff), **Test run** (`TestRunPanel` content). Create in the same drawer (create mode). Retire `template-form-dialog` modals; delete keeps `ConfirmDialog` (type-to-confirm).
- Tests: row→drawer, tab content, OCC 412 in-drawer, no modal for edit.

### 4. DNA writing styles — grid + slide-over

- `stats` slot ← `DashboardCard` roll-up strip (+ live job progress chip, SSE/poll logic unchanged). Fill grid (doctor · version · status · updated). Slide-over: doctor detail + report versions + edit (If-Match). `GenerateReportDialog` remains (short action dialog).
- Tests: stats strip, row→drawer, live progress states unaffected.

### 5. Audio pipelines — master–detail slide-over

- Fill grid (pipeline · slug · engine · default ★ · status). Slide-over tabs: **Config** (YAML editor — existing `ConfigEditorCard` content; TASK-437 `CodeEditor` if YAML mode is trivial, else keep current textarea editor and note it), **Versions**, **Lifecycle** (assign/default/toggle, elevated-gated as today). Create → drawer create mode.
- Tests: row→drawer, toggle/default actions, elevated gating.

### 6. Harness workflows — live grid + slide-over

- Fill grid, cursor paging preserved (`keepPreviousData`). Slide-over: phase checklist (NER→ASSEMBLE→GENERATE→SENSORS→GATE), signals, cancel/terminate (break-glass-free confirms as today).
- **Polling**: `refetchInterval` (e.g. 5s) on list+selected detail while any visible run is non-terminal; pause on hidden tab; manual Refresh retained. Footer `start` reflects "Live · refreshed {rel}".
- Tests: polling on/off by run-state, drawer actions, cursor paging intact.

### 7. Storage browser — grid + breadcrumb

- Toolbar: bucket select + search; **breadcrumb path bar** from `prefix`; fill grid name · type · size · modified (folders first). Object actions (presign/download, delete) in a compact slide-over or row actions (artboard 3e shows grid-first; actions drawer only if multi-action). Upload button unchanged.
- Tests: breadcrumb navigation, prefix URL state, actions.

### 8. Verification & evidence

- [ ] Per page: screen tests green; `pnpm --filter @arcaai/admin-console build lint test` (paste output)
- [ ] axe 0 violations per screen
- [ ] AC: identical frame ×6; no record modals left (repo grep for retired dialogs); tablet/mobile collapse verified via `next-dev-loop` (screenshots vs 3c/5e)
- [ ] Playwright e2e updated: `agents`, `audio-pipelines`, plus new `departments`, `harness-workflows` happy paths
- [ ] Change log per page appended here as each sub-task lands

## Implementation Summary

All six tenant-scoped pages were migrated to the shared frame + `DetailDrawer` pattern (Agents was built first as the reference; the other four grid pages follow it; Departments is the bespoke 3-pane). One small backend change surfaces the member **lead** flag.

### Deviations from the original plan (approved with the user, 2026-07-08)

1. **Departments prompt-config** — the plan called for a "default agent Select + tone override", but `UpdateDepartmentPromptConfigRequest` has **no such fields** (only the 4 prompt-ID slots). Decision: **Select-ify the existing 4 prompt-ID inputs** from the tenant's prompt-template catalog (a read of the existing `GET /admin/prompt-templates`, added as `usePromptTemplateOptions` in the departments feature — no backend/endpoint change). No new DB/DTO fields.
2. **Tenant banner** — kept global-only (see AC above).
3. **Lead marker** — no lead/primary field was on the members DTO; **added `isLead`**, derived from the existing `UserDepartment.isPrimary` column (no migration). Semantic note in code: `isPrimary` = the user's primary department, surfaced as the closest available "lead" signal.
4. **Audio Config editor** stays a `<Textarea>` — the `@arcaai/ui` `CodeEditor` is JSON-only (no YAML), which the plan already permitted.

### Per-page changes

| Page | What changed | New/removed files |
|---|---|---|
| **Agents** `/agents` | Fill-height grid (added a **Type/category** column) + `DetailDrawer` with Overview (edit, OCC) / Versions / Test-run tabs + **create mode**; delete keeps the type-to-confirm `ConfirmDialog`. | + `agent-detail.tsx`; `template-form-dialog.tsx` refactored to exported `CreateTemplateForm`/`EditTemplateForm` bodies (dialogs retired). |
| **DNA writing styles** `/dna-writing-styles` | `DashboardCard` → `stats` slot (SSE/poll job-progress unchanged); fill grid; doctor detail + versions + edit → slide-over; `GenerateReportDialog` kept. | + `doctor-detail.tsx`; − `doctor-detail-panel.tsx`. |
| **Audio pipelines** `/audio/pipelines` | Fill grid; slide-over tabs Config (YAML textarea) / Versions / Lifecycle (elevated-gated); create-in-drawer; `?pipeline=` selection. | + `pipeline-detail.tsx`; − `create-pipeline-dialog.tsx`; `config-editor-card.tsx`/`versions-lifecycle-panel.tsx` split into tab bodies. |
| **Harness workflows** `/harness/workflows` | Fill grid (cursor paging preserved) + real slide-over (phases · signals · cancel/terminate); **added live polling** (`refetchInterval` while `RUNNING`, hidden-tab-paused) via pure predicates in `api/polling.ts`; footer shows `Live · refreshed {rel}`. | + `api/polling.ts`; `workflow-detail-drawer.tsx` → overlay; − `signals-lifecycle-panel.tsx` (folded in). |
| **Storage browser** `/storage` | Fill grid; bucket `Select` + search + breadcrumb (`PrefixChips`) + compact `UploadZone` in the toolbar; `name · type · size · modified` columns (folders first); object actions → `?object=` slide-over; storage health verdict moved to footer. | + `object-detail.tsx`; − `bucket-list-card.tsx`. |
| **Departments** `/departments` | 3-pane tree \| members \| **prompt-config pane** (4 Selects, OCC PATCH); department create/edit/delete → `DetailDrawer`; **Lead** chip on members; responsive collapse via `useViewportTier`. | + `department-detail.tsx`, `department-prompt-config-panel.tsx`; − `department-edit-panel.tsx`, `create-department-dialog.tsx`; api gains `usePromptTemplateOptions`. |
| **Backend (members `isLead`)** | `GET /admin/departments/:id/users` now returns `isLead` per member, from `UserDepartment.isPrimary`. | `packages/applications`: `user.response.ts` (+`isLead`), `department.service.ts` (inject `UserDepartmentRepository`, stamp `isLead`). No schema/migration. |

## Verification (evidence — 2026-07-08)

- **`pnpm --filter @arcaai/admin-console test`** → **106 files, 810 tests passed** (all six screens' unit/interaction suites, TDD-updated: drawer interactions, tab-landing via `?…=` searchParams since Radix tab clicks are unreliable in jsdom, OCC headers/bodies, live-polling predicates, Lead chip, compact collapse).
- **`pnpm --filter @arcaai/admin-console lint`** → clean (`eslint src --max-warnings 0`, 0 warnings).
- **`pnpm --filter @arcaai/admin-console build`** → success; all routes compiled (incl. `/agents`, `/audio/pipelines`, `/departments`, `/dna-writing-styles`, `/harness/workflows`, `/storage`).
- **`pnpm --filter @arcaai/applications test`** → **272 files, 5873 tests passed** (incl. the new `getDepartmentUsers` `isLead` case); `build` green.
- **e2e**: `storage-browser`, `audio-pipelines`, `dna-writing-styles`, `harness-workflows` specs updated to the new drawer/fill-grid DOM (the retired side-panel assertions replaced with grid + slide-over). `agents`/`departments` specs unaffected (toolbar/tree selectors unchanged). **Not executed this session** — these are RUNNING-stack Playwright specs (require the live app + gateway) and self-skip when the stack is down.

### Not yet done (open for the Review gate)
- axe 0-violations per screen and both-theme visual QA run against a **live** stack (the a11y scans live in the e2e specs, gated on the running stack).
- Runtime verification in a driven browser (`next-dev-loop`) against real BFF/gateway data.
- New `departments` / `harness-workflows` happy-path e2e beyond the smoke+a11y specs, if desired.

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §7 + artboards 3c–3i/5e; per-page current-state matrix captured; endpoints confirmed against feature clients (spec paths representative). Status: Pending (awaiting plan approval). |
| 2026-07-08 | Implemented all six pages + members `isLead`. Three plan/reality gaps resolved with the user: prompt-config Select-ified (no new backend fields), global-tenant-banner-only, `isLead` derived from `UserDepartment.isPrimary`. Agents built as the reference slide-over pattern; DNA/Audio/Harness/Storage/Departments migrated to fill-grid + `DetailDrawer`; Harness gains live polling. admin-console `build lint test` green (810 tests); applications green (5873 tests, +`isLead` case). e2e specs updated to new DOM (not executed — need live stack). Status → Review. |
