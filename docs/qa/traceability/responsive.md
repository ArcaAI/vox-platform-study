> _Relocated from `docs/implementation/TASK-384-Responsive-Admin-Surfaces/TRACEABILITY-MATRIX.md` (TASK-385 docs alignment)._

# TASK-384 — Responsive Admin Surfaces Traceability Matrix

> **What this is:** a **responsive-behavior → design frame → implementing file → test** map
> for the cross-cutting Desktop/Tablet/Mobile pass. Mirrors the format of
> [TASK-371 TRACEABILITY-MATRIX.md](./README.md)
> (same legend). Because this ticket is **frontend-only**, the API column is replaced by
> **Implementing file:line (`apps/admin`)** — there is **no backend behavior** to assert
> (see *Backend* note below).

| | |
|---|---|
| **Ticket** | TASK-384 |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | All responsive primitives built; pure logic unit-tested 🟢; transforms covered by authored FE E2E (run pending a seeded stack) 🟡 |
| **Sources** | Design = `HOPE-Admin-Console` foundation `07 · Responsive` `62:1082`, `06 · Multi-Tenancy` `61:985` ([screenshots](../../implementation/TASK-371-Admin-Console-Redesign/screenshots/)); Impl = live `apps/admin` source; Tests = `apps/admin/e2e/task-384-responsive.spec.ts` (FE E2E) + `apps/admin/src/**/__tests__` (vitest) |

## Legend

| Symbol | Meaning |
|---|---|
| 🟢 | **Built & automated-tested** (passing vitest unit test, or live-run E2E) |
| 🟡 | **Built, partial test** — in code; covered by unit-tested pure logic and/or **authored** FE E2E pending a live stack, but the CSS-variant transform itself has no green automated assertion yet |
| 🔴 | **Gap** — designed but not built and/or no test |
| 🎯 | **Target** — design-only, intentionally deferred (no implementation this ticket) |
| 🔒 | **super-admin-only** surface |

**Conventions:**
- `file:line` refs verified against live `apps/admin` source on 2026-06-30.
- Breakpoints (TASK-384 model): **mobile `< md 768`**, **tablet `md..lg 768–1023`**, **desktop `≥ lg 1024`**. Dialog full-screen uses the tighter **`sm` (640)** boundary (documented nuance — see DESIGN-SPEC §1).
- Tests run across three Playwright **projects** (`apps/admin/playwright.config.ts`): `desktop` 1280×800, `tablet` 834×1112, `mobile` 390×844.

---

## 1. Application shell — 3-tier sidebar (`07 · Responsive` `62:1082`)

| ID | Behavior | Design (frame · node) | Implementing file:line (`apps/admin`) | Test | Status |
|---|---|---|---|---|---|
| S1 | Desktop: full `w-64` sidebar (icon + label) | `07 · Responsive` `62:1082` (desktop baseline) | `src/components/layout/app-shell.tsx:171` (`md:w-16 lg:w-64`) | `e2e/task-384-responsive.spec.ts` › *desktop · sidebar full* | 🟡 |
| S2 | Tablet: **icon-rail `w-16`** (icons only, labels hidden, `aria-label`/`title`) | `07` *Tablet 768 · icon-rail shell* | `app-shell.tsx:171,27,51` (`BrandMark`/`SidebarNav` `rail`) | `task-384-responsive.spec.ts` › *tablet · icon-rail (no nav labels)* | 🟡 |
| S3 | Mobile: sidebar hidden → hamburger opens modal **drawer** (`Sheet`, scrim) | `07` *Mobile 360 · nav drawer + tenant switch* | `app-shell.tsx:191–209` (`Sheet`, `w-[86vw] max-w-80`) | `task-384-responsive.spec.ts` › *mobile · drawer opens from hamburger* | 🟡 |
| S4 | Mobile: header app-bar actions + hamburger ≥ 44px | `07` *Mobile · app bar* | `app-shell.tsx:193` (`size-11 md:hidden`), `:89,:101,:133` (`max-md:size-11`) | `task-384-responsive.spec.ts` › *mobile · hamburger ≥44px* | 🟡 |
| S5 | Drawer pins **full** tenant switcher at the bottom | `07` *nav drawer + bottom tenant switch* | `app-shell.tsx:205–207` | `task-384-responsive.spec.ts` › *mobile · drawer tenant switcher* | 🟡 |

Cross-link: TASK-371 README §5.4 (`07`) shell tiers.

## 2. Working-tenant switcher — collapsed variant (`06 · Multi-Tenancy` `61:985`)

| ID | Behavior | Design (frame · node) | Implementing file:line (`apps/admin`) | Test | Status |
|---|---|---|---|---|---|
| W1 | Desktop/drawer: full switcher (avatar + 2-line + chevron; super-admin popover) | `06` *Working-tenant switcher · expanded popover* | `src/features/tenants/working-tenant-switcher.tsx:62–91` | `task-384-responsive.spec.ts` › *desktop · tenant switcher full* | 🟡 |
| W2 | Tablet rail: **`collapsed`** avatar-only (super-admin popover trigger / tenant-admin chip) | `06` *Working-tenant switcher · Collapsed (sidebar footer)* | `working-tenant-switcher.tsx:21,38–51,65–90`; shell `app-shell.tsx:180–185` | `task-384-responsive.spec.ts` › *tablet · collapsed switcher (no label)* 🔒 | 🟡 |
| W3 | "Acting on" banner / NoTenant state reflow inside content column | `06` *Acting-on context · NoTenant* | `src/features/tenants/tenant-context.tsx` (`ActingOnBanner`, `NoTenantState`) | covered indirectly (TASK-371 §5.12) | 🟡 |

Cross-link: TASK-371 matrix **F8** (working-tenant switch).

## 3. Data grids — condensed table + card-list + FAB (`07 · Responsive` `62:1082`)

| ID | Behavior | Design (frame · node) | Implementing file:line (`apps/admin`) | Test | Status |
|---|---|---|---|---|---|
| G1 | Desktop: full `VirtualizedDataGrid` (all columns) | `07` desktop table | `src/features/data-grid/responsive-data-grid.tsx:82` | `task-384-responsive.spec.ts` › *desktop · grid table visible* | 🟡 |
| G2 | Tablet: **condensed** columns (`selectCondensedColumns`) | `07` *Tablet · condensed table* | `responsive-data-grid.tsx:65–68`; helper `features/data-grid/responsive-grid.ts:22` | `features/data-grid/__tests__/responsive-grid.test.ts` › *selectCondensedColumns* | 🟢 |
| G3 | Mobile: **card-list** (avatar/title/subtitle/badge + chevron) | `07` *Mobile · card list* | `responsive-data-grid.tsx:70,92,197–224` | `task-384-responsive.spec.ts` › *mobile · card-list (no grid table)* | 🟡 |
| G4 | Mobile: **FAB** for the primary action; desktop button `max-md:hidden` | `07` *Mobile · FAB (+)* | `responsive-data-grid.tsx:260–269`; tenants `routes/.../tenants/index.tsx:129,105`; tenant-users `.../$tenantId/users/index.tsx:367,341` | `task-384-responsive.spec.ts` › *mobile · FAB present* | 🟡 |
| G5 | Mobile: card-list search (server `globalSearch` or client `mobileFilter`) | `07` *Mobile · full-width search* | `responsive-data-grid.tsx:108–120,148–158`; tenants `index.tsx:126` | `task-384-responsive.spec.ts` › *mobile · search field* | 🟡 |
| G6 | Mobile: `from–to of total` pager, ≥44px prev/next | `07` *Mobile · pagination* | `responsive-data-grid.tsx:131–134,227–258`; helper `responsive-grid.ts:49` | `responsive-grid.test.ts` › *paginationSummary* | 🟢 |
| G7 | Card-list skeleton / empty / error states | foundation `10-skeleton-loading.mdc` | `responsive-data-grid.tsx:161–195` | `task-384-responsive.spec.ts` › *mobile · loading skeleton* | 🟡 |
| G8 | Tenants grid wired (condensed + card + client filter + FAB) | `13 · Tenant Management` `69:1416` (responsive) | `routes/_authenticated/tenants/index.tsx:111,124,130,129` | `task-384-responsive.spec.ts` › *tenants D/T/M* | 🟡 |
| G9 | Users grid wired (condensed + card; server-paginated) | `20u · Data Grid` `120:9015` (responsive) | `routes/_authenticated/users.tsx:166,182,184` | `task-384-responsive.spec.ts` › *users D/T/M* | 🟡 |
| G10 | Tenant Users grid wired (condensed + card + FAB + per-row kebab) | `20p · Users` `97:6529` (responsive) | `routes/_authenticated/tenants/$tenantId/users/index.tsx:348,365,368,141` | `task-384-responsive.spec.ts` › *tenant users D/T/M* | 🟡 |

Cross-link: TASK-371 matrix **F1** (tenant list), **U1** (users grid).

## 4. Detail pages — tabs → `Select` (`07 · Responsive` `62:1082`)

| ID | Behavior | Design (frame · node) | Implementing file:line (`apps/admin`) | Test | Status |
|---|---|---|---|---|---|
| T1 | Desktop/Tablet: horizontal underline tabs | `07` *blade drill-down · detail header* | tenant `routes/.../$tenantId/route.tsx:227–242`; user `.../$userId.tsx:240–255` | `task-384-responsive.spec.ts` › *desktop · underline tabs* | 🟡 |
| T2 | Mobile: tabs → `h-11` **`Select`** (tenant detail, pathname-driven) | `07` *Mobile · sub-section select* | `routes/.../$tenantId/route.tsx:212–226` | `task-384-responsive.spec.ts` › *mobile · tenant detail Select* | 🟡 |
| T3 | Mobile: tabs → `h-11` **`Select`** (user detail, 7 panels, local state) | `07` *Mobile · blade drill-down detail* | `routes/.../$tenantId/users/$userId.tsx:225–239` | `task-384-responsive.spec.ts` › *mobile · user detail Select* | 🟡 |
| T4 | Mobile drill-down realized as a **page route** (not a stacked blade) | `07` *blade drill-down* (page, per TASK-371 §5.12) | `routes/.../$tenantId/users/$userId.tsx` (route) | covered by G10 card `onClick` → route | 🟡 |
| T5 | *Impersonate user* primary action + indigo `--ai` mode banner | `07` *blade drill-down · Impersonate* / `06` *impersonation banner* | — (not built) | — | 🎯 (out of TASK-384 scope) |

Cross-link: TASK-371 README §5.12–5.13 (page-based detail + responsive tab model).

## 5. Dialogs — full-screen on mobile + ≥44px (`07 · Responsive` cross-cutting)

| ID | Behavior | Design (frame · node) | Implementing file:line (`apps/admin`) | Test | Status |
|---|---|---|---|---|---|
| D1 | Shared fragments: full-screen content + ≥44px footer | `07` cross-cutting (≥44px targets) | `src/lib/responsive.ts:17,25,28` | type-check + build (arbitrary-variant compile) | 🟢 |
| D2 | Tenant form dialog full-screen on mobile | `Dlg · Add Tenant` `110:7669` (responsive) | `src/features/tenants/tenant-form-dialog.tsx:69,112` | `task-384-responsive.spec.ts` › *mobile · tenant dialog full-screen* | 🟡 |
| D3 | User create / edit dialogs full-screen on mobile | `Dlg · Create User` `120:10354` (responsive) | `features/users/user-create-dialog.tsx:88,218`; `user-edit-dialog.tsx:76,140` | `task-384-responsive.spec.ts` › *mobile · user dialog full-screen* | 🟡 |
| D4 | Department form + checkbox picker dialogs full-screen | `Dlg · Add Members` `110:8201` (responsive) | `features/tenants/department-form-dialog.tsx:52,76`; `features/common/checkbox-picker-dialog.tsx:80,122` | type-check + build | 🟡 |
| D5 | Global Departments/Prompts dialogs full-screen (review-pass close) | `34p · Departments` `110:7195` (responsive) | `routes/_authenticated/departments.tsx:80,96,306,379,398,404` | type-check + build | 🟡 |
| D6 | Long-tail: agent-instruction / policy-form / `AlertDialog` confirms | — | — (README §7 backlog) | — | 🔴 |

## 6. Dashboards / KPI grids — reflow only (no JS, no TASK-384 change)

| ID | Behavior | Design (frame · node) | Implementing file:line (`apps/admin`) | Test | Status |
|---|---|---|---|---|---|
| K1 | Platform dashboard KPI grid 1→2→4-up | `10 · Dashboard` `69:1265` (responsive) | `routes/_authenticated/dashboard.tsx:199,234` (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-4`) | `task-384-responsive.spec.ts` › *dashboard KPI reflow* | 🟡 |
| K2 | System-health KPI grid 1→2→4-up + tables stack `lg:grid-cols-2` | `11 · Monitoring` `70:1692` (responsive) | `routes/_authenticated/system-health.tsx:181,234` | covered by K1 pattern | 🟡 |
| K3 | Tenant overview KPI/activity reflow (`sm:grid-cols-2 xl:grid-cols-4`, `lg:grid-cols-3`) | `18p · Overview` `95:6164` (responsive) | `routes/_authenticated/tenants/$tenantId/overview.tsx:210,248,293` | covered by K1 pattern | 🟡 |
| K4 | Bespoke tables fall back to shadcn `Table` horizontal scroll | `02 · DataGrid` `60:745` | shared `@arcaai/ui` `Table` (`relative w-full overflow-x-auto`) — no app change | n/a (verified, no change) | 🟢 |

## 7. Pure logic — unit-tested (🟢)

| ID | Behavior | Implementing file:line (`apps/admin`) | Test | Status |
|---|---|---|---|---|
| L1 | `useBreakpoint()` 3-tier resolution + `matchMedia` reactivity | `src/hooks/use-breakpoint.ts:21,49` | `hooks/__tests__/use-breakpoint.test.ts` (5 cases) | 🟢 |
| L2 | `getColumnId` / `selectCondensedColumns` (keep + order + empty) | `features/data-grid/responsive-grid.ts:11,22` | `features/data-grid/__tests__/responsive-grid.test.ts` | 🟢 |
| L3 | `paginationSummary` (first/middle/last/empty/clamp) | `features/data-grid/responsive-grid.ts:49` | `responsive-grid.test.ts` › *paginationSummary* (5 cases) | 🟢 |

---

## Backend

**n/a — responsive is frontend-only.** TASK-384 adds breakpoint-conditional layout/styling and
runtime breakpoint signals only; it introduces **no new endpoint, request/response shape, query
param, or server behavior**. The grids reuse the existing `GET /admin/users` (TASK-371 **U1**) /
`GET /admin/tenants` (**F1**) contracts unchanged. No `apps/api/tests/e2e/task-384-responsive.spec.ts`
is added; the real data flows those screens depend on are already covered by
`apps/api/tests/e2e/task-375-admin-features.spec.ts` (Users sort/filter/search/paging) and the
TASK-371 matrix rows.

## Coverage snapshot

- **6 surface classes** mapped (shell · switcher · grids · detail tabs · dialogs · KPI reflow) + 3 pure-logic units.
- **Pure logic 🟢** — `useBreakpoint`, `selectCondensedColumns`, `paginationSummary`, `getColumnId` all have passing vitest unit tests.
- **Transforms 🟡** — built and exercised by the **authored** FE E2E (`task-384-responsive.spec.ts`); flips to 🟢 on a live-stack run (`pnpm exec playwright test --config apps/admin/playwright.config.ts`). Spec discovery passes today (`--list`).
- **🎯 / 🔴** — impersonation (T5, design-only, other ticket) and the long-tail dialogs (D6, README §7).
