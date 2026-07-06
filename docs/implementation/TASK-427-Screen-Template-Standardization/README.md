# TASK-427 — Admin Console Screen Template Standardization

- **Status**: Review
- **Type**: refactor (UX/UI standard + Figma + migration)
- **Owner**: admin-console
- **Related**: TASK-415 (Hope Admin Console), TASK-421 (Pinned Shell Chrome), TASK-423 (Data Grid Standardization) — this ticket generalizes the pinned-chrome + fill-height-grid work into a single, reusable **screen frame** that every screen instances.

## Requirement Analysis

Most screens hand-roll their page layout (`<div className="flex … flex-col gap-4">` + `PageHeader` + optional `FilterBar` + grid/cards). The result is inconsistent: on some pages the header/toolbar/stats scroll away, dashboards miss `min-h-0` (so nothing pins), and there is no page-level footer. The product owner specified a single **screen-template region contract**:

1. **Pinned at the top** (priority order): `header` (breadcrumbs live in the shell topbar; title + actions here) → `stats` cards/badges → `statusBanner` (page-level status/alerts) → `toolbar` (search / filters / actions) → `tabs`.
2. **Full-width content** (priority order): main content / charts → tab panels → data grid. For a data grid the pagination is pinned at the **bottom of the grid, directly above the footer**.
3. **Pinned at the bottom** as a footer: an IDE-style **status bar** (status / message / counts).

### Decisions (confirmed with product owner)

- **Two status surfaces**: TOP = contextual banners (impersonation / "Acting on: Tenant" / page alerts) — already pinned in the shell chrome (`(console)/layout.tsx`) + an optional page-level `statusBanner` slot; BOTTOM = new IDE-style footer status bar (`StatusFooter`).
- **Breadcrumbs stay in the shell topbar** (`SiteHeader`); the page header carries title + actions only.
- **Scope**: all ~34 admin-console screens (list + detail + dashboards).
- **Scroll model**: the console uses the **app-like inner-scroll model** (the shell inset owns the viewport height; only the content region scrolls), not the window-scroll model. Rule 11 §1 is updated to make this explicit (it was already de-facto after TASK-421/423).

## Current State Evaluation

- Shell (`apps/admin-console/src/app/(console)/layout.tsx`): sticky topbar + session banners (chrome) above a `min-h-0 flex-1 overflow-y-auto` content region (padding `p-4 md:p-6`). Breadcrumbs in `SiteHeader`.
- `VirtualizedDataGrid` (`@arcaai/ui`) already does header-sticky / body-scroll / pagination-at-bottom **internally** when `fill` (its default: `fill = height == null`). `AdminDataGrid` wraps it. So the grid half of the contract is already met — the gap is the **page frame** around it.
- Screens compose the frame ad-hoc; no shared component; no footer status bar anywhere.

## Implementation Plan

**Task 1 — Standard + Figma (this must land before the sweep):**

1. `ScreenTemplate` + `StatusFooter` shared components in `apps/admin-console/src/shared/page/` (the code form of the standard). ✅
2. Unit tests: region order, content modes, footer semantics. ✅
3. Pilot-migrate two representative screens: `tenants-list` (grid → `fill`) and `harness-observability` (toolbar + `scroll`). ✅
4. Update rules `11-ux-ui-principles.mdc` (scroll model + Screen Template section) and `12-design-workflow.mdc` (frame 09 region contract). ✅
5. Update `docs/development-patterns-and-standards.md` + `apps/admin-console/README.md`. ✅
6. Update Figma `09 - Screen Templates` to the sticky-region contract. ✅ — added the full-width **"Screen frame — region & scroll contract (TASK-427)"** card (node `98:2978`): 7 labelled region bands (pinned top group teal, scrolling content dashed with the pagination strip pinned at its bottom, pinned footer) + a written contract annotation. Evidence: `figma-evidence/after-09-screen-templates.png`, `figma-evidence/after-09-contract-card.png`. Tablet/mobile variants deferred: the region **order** is orientation-agnostic and responsive collapse (toolbar/pager) is already specced in frame `08 - Data Grid` (TASK-423).

**Task 2 — Migration sweep (after Task 1):**

7. Audit all screens; record compliance + gaps.
8. Migrate every screen to `ScreenTemplate` (parallel agents, in batches mirroring the Figma groups).
9. Verify: unit tests + lint + types + axe a11y; capture evidence here.

## The Standard — `ScreenTemplate`

`apps/admin-console/src/shared/page/screen-template.tsx` — fills the shell content region as a fixed-height flex column so only the content scrolls; the top group is pinned above and the footer below. Because it is a flex frame (not `position: sticky`), pinned regions never overlap content or obscure focus (WCAG 2.4.11) — no z-index/backdrop/`scroll-mt` needed.

```tsx
<ScreenTemplate
    header={<PageHeader title="…" actions={…} />}   // required
    stats={…}            // optional pinned strip
    statusBanner={…}     // optional pinned page alert
    toolbar={<FilterBar>…</FilterBar>}  // optional; grid pages carry the toolbar INSIDE the grid
    tabs={<TabsList variant="line">…</TabsList>}  // optional; underline (standard); wrap the whole template in <Tabs>, panels go in children
    contentMode="fill"   // 'fill' for a fill-height AdminDataGrid; 'scroll' (default) for content/detail/dashboards
    footer={<StatusFooter start={…} end={…} />}  // optional pinned bottom status bar
>
    {/* main content / charts / tab panels / data grid */}
</ScreenTemplate>
```

- **Grid pages** → `contentMode="fill"`, child is the `AdminDataGrid` (its own toolbar/body/pagination). The grid pagination lands directly above the footer.
- **Content / detail / dashboard pages** → `contentMode="scroll"` (default); the content region scrolls between the pinned top group and footer.
- **Tabs** → wrap the template in `<Tabs>`; `<TabsList variant="line">` (underline — the standard, not the bare `<TabsList>` pill default) to `tabs`, `<TabsContent>` panels as `children` (shared context across regions).
- Never nest a second scroll area inside `fill` content (rule 11 "one scroll container per panel").

## Implementation Summary

- **New shared frame**: `apps/admin-console/src/shared/page/screen-template.tsx`, `…/status-footer.tsx`, `…/__tests__/screen-template.test.tsx` (5 tests).
- **Migrated — all 34 screens** to `ScreenTemplate`:
  - **Grid → `fill`** (10): tenants-list, users-list, roles, policies, api-keys, audit-logs (cursor), ai-models, schedulers, queues, settings (grid inside a hoisted `<Tabs>`).
  - **Tabbed → `<Tabs>`-wrapped** (6): settings, tenant-storage, harness-policy, entitlements, user-detail, tenant-detail. The `<Tabs>` is hoisted to wrap the whole template (`className="flex min-h-0 flex-1 flex-col"`) so `TabsList` (tabs slot) and `TabsContent` (children) share context and the frame fills — without the flex-column class the nested template collapses (fixed post-migration).
  - **Dashboards w/ `stats`** (4): monitoring, platform-dashboard, queue-detail, transcription-jobs (Failed StatCard keeps its filter-`<button>` semantics).
  - **`statusBanner`** consumers: platform-dashboard + rate-limits (stale `ErrorBanner`), entitlements (`EnforcementCard`), pstudio (prod-data `Alert`), tenant-profile (`OccConflictAlert`), consultations (cross-tenant notice).
  - **Master-detail / scroll** (rest): harness-observability, harness-workflows, audio-pipelines, dna-writing-styles, agents, consultations, storage-browser, pipeline-policy, departments, account, tenant-profile. Embedded fixed-height grids and side panels stay in `children` (scroll, never `fill`). `pstudio` = single `fill` iframe surface.
- **Conventions applied everywhere**: endpoint hint moved from the header `meta` to the footer `end` (`<span className="font-mono">`); page-level toolbars/`FilterBar`s → `toolbar` slot (section-scoped filters stay in `children`); overlays (dialogs/sheets/confirms) kept as fragment siblings OUTSIDE the template; `WorkingTenantGate`/session guards remain the outermost wrapper.
- **Migration executed by 7 parallel agents** (batches A1–A7), each verifying its own screens; the four A3 `<Tabs>` wrappers were then normalized to `flex min-h-0 flex-1 flex-col` for correct fill.

### Verification (evidence)

Full admin-console gate, run from repo root 2026-07-06:

```
pnpm --filter @arcaai/admin-console check-types   → tsc --noEmit, exit 0
pnpm --filter @arcaai/admin-console lint          → eslint src --max-warnings 0, exit 0
pnpm --filter @arcaai/admin-console test          → Test Files 79 passed (79) · Tests 555 passed (555)
```

Only one test needed a (minimal, intent-preserving) edit: `user-detail-screen.test.tsx` `getByText('Active')` → `getAllByText('Active')` because the status badge now also renders in the footer. Visual verification of the pinned frame (settings fill-grid-in-tab, a scroll-tabs page, a grid page) captured in `figma-evidence/` / noted in Change History.

## Screen Inventory & Audit (Task 2)

Audited 2026-07-06 by four parallel read-only agents. **34 screen components total**: 2 pilots already compliant, 32 to migrate. None of the 32 use `ScreenTemplate` — every one hand-rolls a root `<div className="flex … flex-col gap-{4,6}">` and puts the `GET /admin/…` endpoint hint in the `PageHeader` meta (moves to the footer `end`). **Every screen has a colocated `__tests__/*.test.tsx`** — migrations must keep them green.

Legend — Kind: `grid` (single data grid) · `tabbed` · `detail` · `dashboard` · `master-detail` (grid embedded beside side panels) · `form` · `browser` · `embed`. contentMode: `fill` = single fill-height grid; `scroll` = everything else.

| # | Screen | Kind | mode | Slots beyond header/footer | Migration notes |
|---|---|---|---|---|---|
| — | `tenants/tenants-list` | grid | fill | — | ✅ pilot |
| — | `harness-ops/harness-observability` | master-detail | scroll | toolbar | ✅ pilot |
| A1 | `users/users-list` | grid | fill | — | grid `actionBar` (bulk); 3 dialogs → fragment siblings |
| A1 | `rbac/roles` | grid | fill | — | 3 overlays (incl. in-file `CreateRoleDialog`) siblings |
| A1 | `rbac/policies` | grid | fill | — | 2 overlays siblings |
| A1 | `api-keys/api-keys` | grid | fill | — | 6 overlays siblings (largest set) |
| A2 | `audit-logs/audit-logs` | grid | fill | — | cursor pager; footer status from rows query, Export dropdown = header actions |
| A2 | `ai-models/ai-models` | grid | fill | — | 2 overlays siblings |
| A2 | `queues/schedulers` | grid | fill | — | `VirtualizedDataGrid` (in-grid toolbar); 2 dialogs siblings |
| A2 | `queues/queues` | grid | fill | — | `VirtualizedDataGrid`; "auto-refresh 15s" → footer `start`; 2 dialogs |
| A3 | `settings/settings` | tabbed grid | **fill** | tabs | **hoist `<Tabs>` to wrap template**; grid is the tab panel; drop `mt-2`; 4 overlays |
| A3 | `storage/tenant-storage` | tabbed | scroll | tabs | hoist `<Tabs>` (4 panels); 2 session guard early-returns; `ProvisionBucketsDialog` sibling |
| A3 | `harness-policy/harness-policy` | tabbed form | scroll | tabs | hoist `<Tabs>` (≤3 elevated-gated panels); `WorkingTenantGate` outer |
| A3 | `entitlements/entitlements` | tabbed | scroll | tabs, statusBanner? | hoist `<Tabs>`; `EnforcementCard` → `statusBanner` (control card); page `ConfirmDialog` sibling |
| A4 | `users/user-detail` | detail | scroll | tabs | hoist `<Tabs>` (5 panels); `UserActionDialogs` sibling; keep 3 early-returns standalone |
| A4 | `tenants/tenant-detail` | detail | scroll | tabs | hoist `<Tabs>` (5 panels); `TenantLifecycleDialogs` sibling; keep early-returns |
| A4 | `monitoring/monitoring` | dashboard | scroll | stats | `StatStrip` → `stats`; "Auto-refresh 30s · updated" → footer `start`; drop inner `flex-1`; update `MonitoringScreenSkeleton` |
| A4 | `platform/platform-dashboard` | dashboard | scroll | stats, statusBanner | `StatStrip` → `stats`; stale `ErrorBanner` → `statusBanner`; drop inner `flex-1`; update `PlatformDashboardSkeleton` |
| A5 | `queues/queue-detail` | detail+grid | scroll | stats | 6 `StatCard`s → `stats`; grid = child; keep error early-return + `useTrailingBreadcrumb`; 6 overlays |
| A5 | `harness-ops/harness-workflows` | master-detail | scroll | toolbar | `FilterBar` toolbar; grid `height=480` (not fill); `WorkingTenantGate` outer |
| A5 | `audio-pipelines/audio-pipelines` | master-detail | scroll | — | 3-col; in-grid toolbar; `ENDPOINT_HINT` shared w/ gate; `WorkingTenantGate` outer |
| A5 | `transcription-jobs/transcription-jobs` | dashboard+md | scroll | stats | 4 `StatCard`s (Failed = filter `<button>`) → `stats`; `WorkingTenantGate` outer |
| A5 | `dna-writing-styles/dna-writing-styles` | master-detail | scroll | — | dashboard tiles stay in side card (NOT `stats`); `WorkingTenantGate` outer |
| A5 | `agents/agents` | master-detail | scroll | — | 3-col; in-grid toolbar; 3 dialogs siblings; `WorkingTenantGate` outer |
| A6 | `consultations/consultations` | dashboard+grid | scroll | statusBanner? | 3 render branches (`useSession` scope); cross-tenant `Card` notice → `statusBanner`; detail panel sibling |
| A6 | `storage-browser/storage-browser` | browser | scroll | toolbar | 3-col, nested grid scroll (NOT fill); endpoints `/storage/*`; `WorkingTenantGate` outer |
| A6 | `rate-limits/rate-limits` | mixed | scroll | statusBanner | stale `ErrorBanner` → `statusBanner`; routes `FilterBar` stays in children (section-scoped); 2 grids; 4 dialogs |
| A6 | `pipeline-policy/pipeline-policy` | matrix | scroll | toolbar | `FilterBar` toolbar; cascade `Table` (not grid); pending/error/empty swap; `WorkingTenantGate` outer |
| A6 | `departments/departments` | browser | scroll | toolbar | custom search bar (not `FilterBar`) → `toolbar`; 3-col; `CreateDepartmentDialog` sibling; `WorkingTenantGate` outer |
| A7 | `pstudio/pstudio` | embed | **fill** | statusBanner | prod-data `Alert` → `statusBanner`; iframe surface → `flex-1 min-h-0` child; 4 status branches |
| A7 | `account/account` | form | scroll | statusBanner? | 3 `<section>`s; endpoints `/user/me/*`; "Acting on …" → optional `statusBanner` |
| A7 | `account/tenant-profile` | form/mixed | scroll | statusBanner | `OccConflictAlert` → `statusBanner`; endpoints `/tenant/me`; NoTenant `EmptyState` in children |

### Migration batches (parallel agents)

`A1`, `A2` = mechanical grid→`fill` (mirror the tenants-list pilot). `A3` = `<Tabs>`-hoist. `A4` = detail-tabs + stat dashboards. `A5` = master-detail/`scroll`. `A6` = misc `scroll`. `A7` = embed + self-service forms. Each agent migrates its screens, then runs the screens' own vitest + eslint and keeps them green.

## Change History

- **2026-07-06** — Created ticket. Built `ScreenTemplate` + `StatusFooter` + tests; piloted on tenants-list and harness-observability. Standard + decisions recorded above. Rules/docs/Figma + full sweep pending.
- **2026-07-06** — **Task 1 complete**: updated rules 11 & 12, `development-patterns-and-standards.md`, and `apps/admin-console/README.md`; added the "Screen frame — region & scroll contract (TASK-427)" card to Figma frame `09 - Screen Templates` (node `98:2978`; evidence in `figma-evidence/`).
- **2026-07-06** — **Task 2 complete**: audited all 34 screens (4 parallel agents; inventory above) and migrated the remaining 32 to `ScreenTemplate` via 7 parallel agents (batches A1–A7). Normalized the four A3 `<Tabs>` wrappers to `flex min-h-0 flex-1 flex-col` (nested template was collapsing). Verified: `check-types` exit 0, `lint --max-warnings 0` exit 0, `test` 79 files / 555 tests passed. One minimal test edit (`user-detail-screen.test.tsx`). Status → Review pending product-owner sign-off + visual spot-check.
- **2026-07-06** — **Fix: tab variant drift.** Visual spot-check found `settings` and `harness-policy` rendered the pill/segmented `<TabsList>` (component default) while the other four tabbed screens (tenant-storage, entitlements, user-detail, tenant-detail) use `variant="line"` (underline). Set both to `variant="line"` so all six tabbed screens are consistent, and pinned `<TabsList variant="line">` as the standard in rule 11, `development-patterns-and-standards.md` §3.7, and the tabs guidance above.
- **2026-07-06** — **Fix: settings "Global/Tenant" tabs removed (redundant).** Investigated a report that the settings grid "doesn't change after switching tabs". Root cause is **not** the frontend (a stateful-adapter regression test confirmed the grid swaps correctly when the two endpoints return different data): the BFF stamps `X-Tenant-Id` for elevated users (`server/hope-proxy.ts`), and `GlobalSettingController.fetchAll` scopes `GET /admin/settings` to the CLS tenant, so the **Global** tab (`fetchAllByTenantId(cls)`) and the **Tenant** tab (`fetchAllByTenantId(workingTenantId)`) resolve to the **same tenant** → identical rows (the working tenant here is `__GLOBAL__`, which holds the 40 rows shown; verified via DB). Per product decision, removed the in-page scope tabs from `settings-screen.tsx` — scope is decided solely by the working-tenant switcher; the screen now renders a single `AdminDataGrid` (`GET /admin/settings`, `aria-label="Settings"`) inside `ScreenTemplate`. Dropped the `scope` nuqs param, `useSession`/`useTenantScopedSettings` usage, and the four tab/scope tests; updated `settings/loading.tsx` (removed the tabs skeleton). The `useTenantScopedSettings`/`listTenantScopedSettings`/`settingKeys.byTenant` API-layer symbols stay (still covered by `settings-api.test.ts`). Verified: `check-types` exit 0, `lint --max-warnings 0` exit 0, `test` 79 files / 552 tests passed.
