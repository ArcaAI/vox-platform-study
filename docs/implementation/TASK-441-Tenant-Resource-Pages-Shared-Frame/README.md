# TASK-441 — Tenant Resource Pages Redesign: One Shared Frame, Slide-Over Detail, 3-Pane Hierarchy

- **Status**: Pending
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

- [ ] All six render the identical frame (banner · header · toolbar · content · footer).
- [ ] One shared detail surface (slide-over → mobile sheet); no bespoke record modals.
- [ ] Empty / loading / error states present per page; live pages poll and reflect run-state.
- [ ] 3-pane collapses correctly at tablet and mobile.

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

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created from build spec §7 + artboards 3c–3i/5e; per-page current-state matrix captured; endpoints confirmed against feature clients (spec paths representative). Status: Pending (awaiting plan approval). |
