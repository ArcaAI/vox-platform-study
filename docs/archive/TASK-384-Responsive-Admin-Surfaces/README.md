# TASK-384 · Responsive Admin Surfaces

| | |
|---|---|
| **Ticket** | TASK-384-Responsive-Admin-Surfaces |
| **Type** | feature (responsive-only pass) |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Completed |
| **Depends on** | TASK-371 (Admin Console Redesign — foundation `07 · Responsive`, `06 · Multi-Tenancy`), TASK-374/379/380–383 (built admin surfaces) |

---

## 1. Requirement Analysis

Implement the **responsive (tablet + mobile)** behavior for the already-built admin-console
screens, matching the approved foundation design **`07 · Responsive`** (frame `62:1082`,
`screenshots/foundation-16-responsive.png`) and the multi-tenancy responsive bits
(`screenshots/foundation-15-multitenancy.png`). The screens are desktop-first in code today.

This is a **RESPONSIVE-ONLY** pass: add breakpoint-conditional layout/styling only. Do **not**
change features, data, copy, or desktop behavior, and do **not** redesign anything.

### Approved responsive model (from the design + README §5.4 / §5.12–5.14)

| Breakpoint | Shell | Tables / grids | Detail tabs | Cards |
|---|---|---|---|---|
| **Desktop** ≥ 1024 (`lg`) | Full sidebar (icon + label) + topbar | Full `VirtualizedDataGrid` | Horizontal underline tabs | 4-up |
| **Tablet** 768–1023 (`md`) | **Icon-rail** sidebar (icons only) + topbar; tenant switcher → avatar | **Condensed** table (lower-priority columns hidden) | Scrollable / segmented tabs | 2-up |
| **Mobile** < 768 | **App-bar** + hamburger → **modal nav drawer** (scrim, nav, **bottom tenant switcher**) | **Card-list** (tap-through, trailing chevron) + **FAB** for primary action | **`Select`** to switch sub-section | 1-up |

Cross-cutting: ≥ 44px touch targets, WCAG 2.2 AA, full-screen dialogs on mobile, semantic
theme tokens only (no hardcoded colors/spacing).

### Acceptance criteria

- App-shell collapses sidebar → icon-rail (tablet) → modal drawer (mobile); header is an app-bar on mobile; tenant switcher placement follows the design across breakpoints.
- The `VirtualizedDataGrid` screens (Tenants, Users, tenant Users) render a **card-list on mobile** and a **condensed table on tablet**; desktop is unchanged.
- Detail pages (tenant detail, Users `$userId`) switch their tab nav to a `Select` on mobile.
- Dashboards / KPI grids / charts reflow cleanly at tablet + mobile.
- Dialogs go (near-)full-screen on mobile with ≥ 44px touch targets.
- All existing tests pass; new pure logic (breakpoint hook, table→card/column-priority transform) is unit-tested.

---

## 2. Current-State Audit — what breaks at tablet / mobile

| Surface | File | Break at tablet/mobile |
|---|---|---|
| **App shell** | `components/layout/app-shell.tsx` | Sidebar is binary: `hidden` < `md`, full `w-64` ≥ `md`. **No icon-rail tier.** Mobile drawer already exists (good). Header action buttons are `size-9` (36px < 44px). |
| **Working-tenant switcher** | `features/tenants/working-tenant-switcher.tsx` | Full-width button (avatar + 2-line text + chevron) — overflows a `w-16` icon-rail; no collapsed variant. |
| **Tenants list** | `routes/_authenticated/tenants/index.tsx` | `VirtualizedDataGrid` with fixed pixel column widths + horizontal scroll + fixed `height`. No card-list. (Client-side data.) |
| **Users grid** | `routes/_authenticated/users.tsx` | Same — server-paginated grid, no mobile card-list. This is the design's literal example. |
| **Tenant Users grid** | `routes/.../$tenantId/users/index.tsx` | Same — server-paginated grid + bulk bar; no mobile card-list. |
| **Tenant detail tabs** | `routes/.../$tenantId/route.tsx` | Link tabs `overflow-x-auto` (scroll OK) but no `Select` on mobile. |
| **User detail (7 tabs)** | `routes/.../$tenantId/users/$userId.tsx` | Button tabs `overflow-x-auto`; no `Select` on mobile. |
| **Platform dashboard** | `routes/_authenticated/dashboard.tsx` | KPI grids already `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4` (reflow OK). Chart fixed height (width responsive). Mostly fine. |
| **Monitoring** | `routes/_authenticated/system-health.tsx` | KPI grid + `lg:grid-cols-2` tables reflow OK, but `MetricTable` (4 cols) can overflow its card horizontally on narrow screens. |
| **Tenant overview** | `routes/.../$tenantId/overview.tsx` | KPI grids reflow OK; chart/activity `lg:grid-cols-3` reflow OK. Mostly fine. |
| **Departments (global)** | `routes/_authenticated/departments.tsx` | Plain `Table` (Departments + Prompts) overflows horizontally on mobile — no card fallback. |
| **Tenant departments** | `routes/.../$tenantId/departments/index.tsx` | `CardGrid` auto-fit (`minColumnWidth`) — already reflows. ✅ |
| **Dialogs** | many | shadcn `DialogContent` is centered, `max-w-[calc(100%-2rem)] sm:max-w-lg` — not full-screen on mobile; footer buttons `h-9` (36px). |

Key technical constraints discovered:
- `packages/ui` `VirtualizedDataGrid` is shared with `ui-playground` → **prefer an app-level wrapper**, not a grid change.
- Admin `vitest.config.ts` **stubs `@arcaai/ui/*` and `@arcaai/vox`** → new **pure-logic** modules + the breakpoint hook must avoid runtime imports of those (type-only imports are fine). The wrapper *component* (imports `@arcaai/ui`) is verified via type-check + build, not vitest.
- `packages/ui/src/hooks/use-mobile.ts` exposes `useIsMobile(breakpoint)` — a single boolean. The design needs a **3-tier** (mobile/tablet/desktop) signal, which doesn't exist → add an app-level `useBreakpoint`.
- Test setup already mocks `window.matchMedia` (`matches:false`); per-test override drives the hook test.

---

## 3. Implementation Plan

### Breakpoint strategy

Tailwind defaults, anchored to the design: **mobile** `< md (768)`, **tablet** `md..lg (768–1023)`,
**desktop** `≥ lg (1024)`. The shell uses pure Tailwind variants (`md:` / `lg:`) where possible;
the table→card and tabs→select switches need JS (the grid is virtualized with pixel widths), so
they use a new `useBreakpoint` hook.

### New, unit-tested pure logic

1. `hooks/use-breakpoint.ts` — `useMediaQuery(query)` primitive + `useBreakpoint()` → `{ breakpoint, isMobile, isTablet, isDesktop }`. Test with mocked `matchMedia`.
2. `features/data-grid/responsive-grid.ts` — pure helpers:
   - `getColumnId(col)` — id ?? accessorKey.
   - `selectCondensedColumns(columns, keepIds)` — tablet column-priority filter (order preserved).
   - `paginationSummary(page, limit, total)` — `from–to of total` + prev/next flags for the mobile pager.

### App-level table→card wrapper (preferred over a `packages/ui` change)

3. `features/data-grid/responsive-data-grid.tsx` — `ResponsiveDataGrid<TData>` wraps `VirtualizedDataGrid`:
   - **desktop** → grid unchanged.
   - **tablet** → grid with `selectCondensedColumns(columns, condensedColumnIds)`.
   - **mobile** + `mobileCard` → self-contained card-list (search bound to `queryState.globalSearch`, skeleton/empty/error states, `paginationSummary` pager, optional FAB). Falls back to the grid if no `mobileCard`.

### Wiring (no feature/data/desktop changes)

4. Tenants, Users, tenant Users → `ResponsiveDataGrid` with a `mobileCard` mapper + `condensedColumnIds` + (where relevant) a mobile FAB for the primary action.
5. App-shell → icon-rail at `md`, full at `lg`, drawer < `md`; ≥ 44px touch targets; working-tenant-switcher gains a `collapsed` (avatar-only) variant for the rail.
6. Detail tabs → keep underline tabs ≥ `md`, render a `Select` < `md` (tenant detail + user detail).
7. Dashboards → confirm KPI reflow; wrap `MetricTable`s in `overflow-x-auto`; make the global Departments/Prompts tables horizontally scrollable on mobile.
8. Dialogs → app-level `max-sm:` full-screen class + ≥ 44px actions on the high-traffic dialogs; backlog the long tail.

### Test list (TDD for pure logic)

- `hooks/__tests__/use-breakpoint.test.ts` — mobile/tablet/desktop resolution + reacts to `matchMedia` change + `useMediaQuery` passthrough.
- `features/data-grid/__tests__/responsive-grid.test.ts` — `getColumnId`, `selectCondensedColumns` (keep/order/empty), `paginationSummary` (first/middle/last/empty/clamp).

---

## 4. Implementation Summary

Delivered the responsive pass with an **app-level** strategy (zero changes to `packages/ui`, so
`ui-playground` is untouched). Breakpoints follow Tailwind defaults anchored to the design:
**mobile** `< md (768)`, **tablet** `md..lg (768–1023)`, **desktop** `≥ lg (1024)`.

### Foundation — app shell

- **Sidebar is now 3-tier**: `hidden` (mobile) → **icon-rail `w-16`** (`md`) → **full `w-64`** (`lg`). `BrandMark` and `SidebarNav` take a `rail` prop that hides labels and centers icons at the `md` tier, with `aria-label`/`title` so the icon-only rail stays accessible. The pre-existing mobile drawer (`Sheet`) was kept and widened to `w-[86vw] max-w-80`.
- **Touch targets**: header actions (theme, density, user menu) and the mobile hamburger grow to `size-11` (44px) on mobile via `max-md:size-11`.
- **Working-tenant switcher** gained a `collapsed` (avatar-only) variant for the icon-rail: an interactive popover trigger for super-admins (tooltip via `title`) and a static avatar chip for tenant-admins. The shell renders `collapsed` at the `md` rail and the full switcher at `lg`.

### Data tables/grids (highest priority) — table → card

- New **`ResponsiveDataGrid<TData>`** wrapper around `VirtualizedDataGrid`:
  - **desktop** → grid unchanged;
  - **tablet** → grid with `selectCondensedColumns(columns, condensedColumnIds)` (lower-priority columns dropped, order preserved);
  - **mobile** + `mobileCard` → a self-contained **card-list** (`<ul><li>` tap-through cards with avatar/title/subtitle/badge/meta + trailing chevron), with its own search (bound to `queryState.globalSearch` server-side, or a client `mobileFilter`), skeleton/empty/error states, a `paginationSummary` pager, and an optional **FAB** for the primary action.
- Wired into the three grid screens — **Tenants** (`condensedColumnIds` + client `mobileFilter` + "New tenant" FAB), **Users** (read-only card-list), **Tenant Users** (FAB + per-row actions menu reused via an extracted `renderUserActions`). The desktop primary-action buttons are hidden on mobile (`max-md:hidden`) in favor of the FAB.

### Detail pages — tabs → `Select`

- **Tenant detail** (`$tenantId/route.tsx`) and **User detail** (`$tenantId/users/$userId.tsx`): underline tabs are kept ≥ `md` (`hidden md:flex`) and replaced by an `h-11` `Select` on mobile (`md:hidden`). Tenant detail derives the active tab from the pathname and navigates on change; user detail binds the `Select` to local tab state.

### Dialogs — full-screen on mobile + 44px targets

- New shared class fragments in `lib/responsive.ts` (`MOBILE_DIALOG_CONTENT`, `MOBILE_DIALOG_FOOTER`, `MOBILE_DIALOG_FOOTER_DEEP`). The content fragment makes a centered shadcn `DialogContent` fill the viewport on mobile (`max-sm:h-dvh w-full max-w-none rounded-none border-0 overflow-y-auto`); the footer fragments grow action buttons to `h-11`. Applied to the high-traffic mutation dialogs: **tenant form**, **user create**, **user edit**, **department form**, **checkbox picker**.

### Dashboards / cards — verified, no code change needed

- KPI/stat grids already reflow `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4` (1 → 2 → 4), charts are fixed-height/responsive-width, and `system-health`'s tables already stack at `lg:grid-cols-2`.
- **Deviation from plan §3.7**: the plan called for wrapping `MetricTable`s and the global Departments/Prompts tables in `overflow-x-auto`. On inspection the shared shadcn `Table` **already** renders inside `<div class="relative w-full overflow-x-auto">`, so those tables scroll horizontally on mobile with **no change required** — leaving them untouched honors the surgical constraint.

## 5. Files Changed

**New (TASK-384):**

| File | Purpose |
|---|---|
| `apps/admin/src/hooks/use-breakpoint.ts` | `useMediaQuery` + 3-tier `useBreakpoint` hook |
| `apps/admin/src/hooks/__tests__/use-breakpoint.test.ts` | Hook unit tests (mocked `matchMedia`) |
| `apps/admin/src/features/data-grid/responsive-grid.ts` | Pure helpers: `getColumnId`, `selectCondensedColumns`, `paginationSummary` |
| `apps/admin/src/features/data-grid/__tests__/responsive-grid.test.ts` | Pure-helper unit tests |
| `apps/admin/src/features/data-grid/responsive-data-grid.tsx` | `ResponsiveDataGrid` wrapper + mobile card-list |
| `apps/admin/src/lib/responsive.ts` | Shared `max-sm:` dialog class fragments |

**Modified (responsive-only edits):**

| File | Change |
|---|---|
| `apps/admin/src/components/layout/app-shell.tsx` | Icon-rail tier, `rail` props, 44px header/hamburger targets, wider drawer |
| `apps/admin/src/features/tenants/working-tenant-switcher.tsx` | `collapsed` avatar-only variant for the rail |
| `apps/admin/src/routes/_authenticated/users.tsx` | `ResponsiveDataGrid` + `mobileCard` + condensed columns |
| `apps/admin/src/routes/_authenticated/tenants/index.tsx` | `ResponsiveDataGrid` + `mobileCard` + `mobileFilter` + FAB |
| `apps/admin/src/routes/_authenticated/tenants/$tenantId/users/index.tsx` | `ResponsiveDataGrid` + `mobileCard` + FAB + extracted `renderUserActions` |
| `apps/admin/src/routes/_authenticated/tenants/$tenantId/users/$userId.tsx` | Tab nav → `Select` on mobile |
| `apps/admin/src/routes/_authenticated/tenants/$tenantId/route.tsx` | Tab nav → `Select` on mobile (pathname-driven) |
| `apps/admin/src/features/tenants/tenant-form-dialog.tsx` | Mobile full-screen + 44px footer |
| `apps/admin/src/features/users/user-create-dialog.tsx` | Mobile full-screen + 44px footer |
| `apps/admin/src/features/users/user-edit-dialog.tsx` | Mobile full-screen + 44px footer |
| `apps/admin/src/features/tenants/department-form-dialog.tsx` | Mobile full-screen + 44px footer |
| `apps/admin/src/features/common/checkbox-picker-dialog.tsx` | Mobile full-screen + 44px footer |
| `apps/admin/src/routes/_authenticated/departments.tsx` | Mobile full-screen + 44px footer on the global Departments/Prompts dialogs (2026-06-30 review pass — closes a §7 long-tail item; class-only) |

**`packages/ui` extension:** none. The grid was extended via an app-level wrapper, not a shared-package change.

**Review-pass artifacts (2026-06-30):**

| File | Purpose |
|---|---|
| `docs/designs/admin/responsive.md` | Authoritative Desktop/Tablet/Mobile responsive model (frames `07`/`06`) |
| `docs/qa/traceability/responsive.md` | Behavior → design frame → implementing `file:line` → test → status |
| `docs/qa/manual-tests/09-responsive.md` | Device/emulator sweep + WCAG 2.2 AA touch-target checklist |
| `apps/admin/e2e/task-384-responsive.spec.ts` | Frontend Playwright responsive-primitive specs across the desktop/tablet/mobile projects |

## 6. Verification Evidence

All gates run from the repo root with `pnpm --filter @arcaai/admin …`. Routes were **not**
regenerated — no route files were added/removed/renamed (only edited).

**`type-check` — exit 0**
```
> @arcaai/admin@0.1.0 type-check
> tsc --noEmit
(no output — exit 0)
```

**`test` — 215 passed**
```
> vitest run
 Test Files  30 passed (30)
      Tests  215 passed (215)
   Duration  2.43s
```

**`build` — exit 0**
```
> vite build
✓ 10984 modules transformed.
✓ built in 10.58s
```
(Pre-existing `chunks > 500 kB` advisory only — unrelated to this pass; the arbitrary `max-sm:[&>button]:h-11` / `[&_button]:h-11` variants compiled cleanly.)

**Lint:** `ReadLints` on every changed/new file → **no new errors**. (Two pre-existing Tailwind
advisories in `app-shell.tsx` — `supports-[backdrop-filter]:bg-card/60`, `max-w-[1400px]` — are on
unmodified lines and were left untouched.)

| Gate | Result |
|---|---|
| `generate-routes` | n/a (no route file changes) |
| `type-check` | ✅ exit 0 |
| `test` | ✅ 215/215 |
| `ReadLints` (changed files) | ✅ no new errors |
| `build` | ✅ exit 0 |
| `packages/ui` type-check/test | n/a (not touched) |

## 7. Backlog (not yet covered)

Responsive items intentionally deferred (lower priority / lower traffic). None block the priority
surfaces.

- **Long-tail dialogs** — the global Departments/Prompts dialogs
  (`routes/_authenticated/departments.tsx` — department form, prompt form, prompt view) **now
  carry** `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` (closed in the 2026-06-30 review
  pass). Still **not yet applied** to: `agent-instruction-dialog`, `policy-form-dialog`, the
  `AlertDialog`-based confirm/disable dialogs (`confirm-delete.tsx` — `AlertDialogContent` needs
  its own fragment, not the `DialogContent` one), and any agent/role sheets. (Pattern is ready —
  apply `MOBILE_DIALOG_CONTENT` + a footer fragment.)
- **Dialog body touch targets** — footer action buttons are 44px on mobile; in-form `Input`/`Select`
  triggers keep their default `h-9`. A dedicated touch-target pass could bump those on mobile.
- **Tenant-detail inner tables** — the grids already get the `ResponsiveDataGrid` treatment; any
  remaining bespoke tables inside tenant-detail sub-tabs rely on the shadcn `Table`
  horizontal-scroll fallback rather than a card-list.
- **Departments (global) card-list** — currently horizontal-scroll (shadcn `Table` default); a
  mobile card-list would be a nicer parity with the other grids if desired.
- **Visual QA** — automated gates pass; a manual device/emulator sweep (or Playwright viewport
  snapshots) against `foundation-16-responsive.png` is recommended before sign-off.

## 8. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-30 | Ticket created — plan + current-state audit. | this README |
| 2026-06-30 | Implemented foundation (icon-rail shell, `useBreakpoint`), table→card `ResponsiveDataGrid` on the 3 grids, detail tabs→`Select`, mobile full-screen dialogs; verified dashboards already reflow. Gates: type-check ✅, 215 tests ✅, build ✅. | see §5 |
| 2026-06-30 | **Documentation + test review pass.** Added `DESIGN-SPEC.md` (authoritative D/T/M model), `TRACEABILITY-MATRIX.md` (TASK-371 format), `MANUAL-E2E-TESTS.md` (device sweep + WCAG 2.2 AA touch-target checklist), and the frontend responsive E2E `apps/admin/e2e/task-384-responsive.spec.ts` (asserts sidebar/grid/tabs/dialog/FAB transforms across the desktop/tablet/mobile Playwright projects). Plan-reviewed §3 vs shipped code (matches; one documented `max-sm` vs `md` dialog-boundary nuance). Closed one §7 long-tail item — applied `MOBILE_DIALOG_CONTENT` + `MOBILE_DIALOG_FOOTER` to the global Departments/Prompts dialogs (`routes/_authenticated/departments.tsx`, class-only). Backend spec **n/a** — responsive is frontend-only. Status → **Completed**. | `DESIGN-SPEC.md`, `TRACEABILITY-MATRIX.md`, `MANUAL-E2E-TESTS.md`, `apps/admin/e2e/task-384-responsive.spec.ts`, `routes/_authenticated/departments.tsx`, this README |
