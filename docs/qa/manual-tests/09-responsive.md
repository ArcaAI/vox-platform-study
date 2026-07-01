> _Relocated from `docs/implementation/TASK-384-Responsive-Admin-Surfaces/MANUAL-E2E-TESTS.md` (TASK-385 docs alignment)._

# TASK-384 — Responsive Admin Surfaces (Manual E2E / Visual QA)

> **Audience:** QA / QC engineers
> **Surface under test:** HOPE Admin Console — the **responsive (Desktop / Tablet / Mobile)**
> behavior across all admin surfaces.
> **Test type:** End-to-end, manual, black-box (UI-driven), device/emulator sweep.
> **Derived from:** the approved design (foundation `07 · Responsive` `62:1082`, `06 ·
> Multi-Tenancy` `61:985`) + [DESIGN-SPEC.md](../../designs/admin/responsive.md). This is the **Visual QA**
> item deferred in [README §7](../../implementation/TASK-384-Responsive-Admin-Surfaces/README.md).
>
> Read [`docs/qa/manual-tests/README.md`](./README.md) first for
> environment prerequisites (§4), personas/accounts (§5), cross-cutting principles (§6),
> and the status legend (§3.3). This suite reuses that **`password123`** seed and those
> personas, and **cross-references** the central `01-multi-tenancy-management.md` /
> `02-user-access-control.md` cases where a flow overlaps (we only assert the **responsive
> layer** on top of those flows — the data flows themselves are covered there).

---

## 1. Scope

| Suite | Responsive behavior | Design (frame · node) |
|---|---|---|
| **RSP-01** | App shell — full sidebar ↔ icon-rail ↔ drawer + bottom tenant switcher | `07` *icon-rail / nav drawer* |
| **RSP-02** | Data grids — full table ↔ condensed columns ↔ card-list + FAB | `07` *condensed table / card list* |
| **RSP-03** | Detail pages — horizontal tabs ↔ `Select` | `07` *blade drill-down* |
| **RSP-04** | Dialogs — centered modal ↔ full-screen on mobile | `07` cross-cutting |
| **RSP-05** | Dashboards / KPI grids — 4-up → 2-up → 1-up reflow | `10`/`11`/`18p` (responsive) |
| **RSP-06** | Accessibility — ≥44px touch targets, focus, dark-mode parity (WCAG 2.2 AA) | `07` *≥44px targets* |

**Out of scope** (other suites / tickets): tenant/user **data** flows (central suite),
impersonation (design-only), automated tests (Vitest/Playwright — see
`apps/admin/e2e/task-384-responsive.spec.ts`).

## 2. Device / emulator sweep matrix

Run every suite below at **each** tier. Use real devices where possible; otherwise the
browser device-toolbar emulator. Repeat the critical rows in **dark mode**.

| Tier | Width band | Sweep widths | Suggested device / emulator |
|---|---|---|---|
| **Desktop** | `≥ 1024` | 1024 (boundary), 1280, 1440 | Desktop Chrome/Safari/Firefox |
| **Tablet** | `768 – 1023` | 768 (boundary), 834, 1023 (boundary) | iPad / iPad Air (834×1112), Surface |
| **Mobile** | `< 768` | 767 (boundary), 390, 360 (small) | Pixel 5 (390×844), iPhone 12/13, Galaxy S (360) |

> **Boundary discipline:** always test the **exact** breakpoint edges — **767↔768** (mobile↔tablet)
> and **1023↔1024** (tablet↔desktop), plus **639↔640** for the dialog full-screen edge
> (`max-sm`). Most layout regressions hide ±1px from a boundary.

## 3. Status legend & flags

Reuse the central legend — `P` Pass · `F` Fail · `B` Blocked · `NA` Not Applicable · `—` Not Run.
Cross-cutting flags (central README §6): **X1** tenant isolation. **Responsive-local
flags** used here: **A1** ≥44px touch target (WCAG 2.5.8), **A2** visible focus ring (2.4.7),
**A3** dark-mode parity (1.4.3 contrast), **A4** no horizontal page scroll / no clipping,
**A5** orientation (reflow holds portrait + landscape, 1.3.4).

---

## RSP-01 — App shell across breakpoints

**Requirement.** One shell adapts: full labeled sidebar (desktop) → icon-only rail (tablet)
→ off-canvas modal drawer with a bottom working-tenant switcher (mobile); the app-bar
hamburger is the only nav entry point on mobile. *(Design `07`; DESIGN-SPEC §2.1–2.2.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ____________

**Roles under test:** `super_admin` (sees Platform tier + tenant switcher); `tenant_admin`
(scoped nav, static tenant chip).

| TC | Title | Tier | Steps | Expected result | Type | Status | Notes |
|----|-------|------|-------|-----------------|------|--------|-------|
| RSP-01.1 | Full sidebar | Desktop ≥1024 | Sign in as `super_admin`; observe sidebar | `w-64` sidebar: icons **+ labels**, section titles, full tenant switcher at footer | Positive | ☐ | |
| RSP-01.2 | Icon-rail | Tablet 768–1023 | Resize/open at tablet | Sidebar narrows to `w-16` icons-only; labels + section titles hidden; tenant switcher = avatar-only | Positive | ☐ | A4 |
| RSP-01.3 | Rail a11y | Tablet | Hover/focus a rail icon; run a screen reader | Each icon exposes its name via tooltip + `aria-label` | A11y | ☐ | A2 |
| RSP-01.4 | Drawer | Mobile <768 | Tap the hamburger | Sidebar is hidden until tapped; a modal drawer slides in with scrim, **full labeled nav**, active item highlighted | Positive | ☐ | |
| RSP-01.5 | Drawer tenant switcher | Mobile | Open drawer; scroll to bottom | Working-tenant switcher pinned at the **bottom** of the drawer ("Acme Health · Working tenant · tap to switch") | Positive | ☐ | cross-ref MT-07 |
| RSP-01.6 | Drawer dismiss | Mobile | Tap scrim / a nav item | Drawer closes (and navigates on item tap) | Positive | ☐ | |
| RSP-01.7 | Tenant-admin nav | All | Sign in as `tenant_admin` | No Platform/Dashboard items; tenant switcher is a **static** chip (no popover) | RBAC | ☐ | X1 |
| RSP-01.8 | Header targets | Mobile | Measure hamburger + theme/density/user buttons | All ≥ 44×44px | A11y | ☐ | A1 |

## RSP-02 — Data grids → condensed table → card-list

**Requirement.** The `VirtualizedDataGrid` screens (Tenants, Users, tenant Users) render the
full grid on desktop, a **condensed** grid (low-priority columns dropped) on tablet, and a
**card-list** (avatar/title/subtitle/status + chevron) with a **FAB** on mobile — no feature
or data change. *(Design `07`; DESIGN-SPEC §2.3.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ____________

**Roles under test:** `super_admin` (Tenants cross-tenant; pick a working tenant for tenant Users).

| TC | Title | Tier | Steps | Expected result | Type | Status | Notes |
|----|-------|------|-------|-----------------|------|--------|-------|
| RSP-02.1 | Full grid | Desktop | Open `/tenants` | Full grid: all columns, sort, faceted filters, search, resize/reorder, pager | Positive | ☐ | cross-ref F1 |
| RSP-02.2 | Condensed grid | Tablet | Open `/tenants` | Grid shows only Name · Key · Status (low-priority columns hidden); no horizontal overflow | Positive | ☐ | A4 |
| RSP-02.3 | Card-list | Mobile | Open `/tenants` | Rows become tap-through **cards** (avatar, name, mono key, status badge, trailing chevron) | Positive | ☐ | |
| RSP-02.4 | Card-list search | Mobile | Type in the mobile search field | List filters; field is full-width and ≥44px tall | Positive | ☐ | A1 |
| RSP-02.5 | FAB | Mobile | Observe bottom-right; tap it | A round **FAB** (+) replaces the header "New tenant" button; tapping opens the create dialog | Positive | ☐ | A1 |
| RSP-02.6 | Card open | Mobile | Tap a card body | Navigates to that tenant's detail page (chevron affordance) | Positive | ☐ | |
| RSP-02.7 | Users grid | All | Open `/tenants/{id}/users` after selecting a working tenant | Same table→card transform; per-row kebab survives into the card; bulk-bar works on desktop | Positive | ☐ | cross-ref U1 |
| RSP-02.8 | Server pager (mobile) | Mobile | On tenant Users card-list, page through | `from–to of total` summary + ≥44px prev/next arrows; pages advance | Positive | ☐ | A1 |
| RSP-02.9 | Empty / loading / error | Mobile | Trigger empty filter; throttle network | Skeleton cards while loading; icon+title+description empty state; alert + Retry on error (never a bare spinner) | Edge | ☐ | |
| RSP-02.10 | Tenant isolation holds | Mobile | As `tenant_admin`, view users card-list | Only own-tenant rows shown; no cross-tenant leakage | Isolation | ☐ | X1 |

## RSP-03 — Detail pages → tabs → Select

**Requirement.** Tenant detail and user detail keep horizontal underline tabs on desktop/tablet
and switch sub-section navigation to a `Select` on mobile; the same panels render either way.
*(Design `07` blade drill-down; DESIGN-SPEC §2.4.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ____________

| TC | Title | Tier | Steps | Expected result | Type | Status | Notes |
|----|-------|------|-------|-----------------|------|--------|-------|
| RSP-03.1 | Tenant tabs | Desktop/Tablet | Open a tenant detail | Horizontal underline tabs (Overview/Users/Configuration/Storage/Departments); active = primary underline | Positive | ☐ | |
| RSP-03.2 | Tenant Select | Mobile | Open a tenant detail | Tabs replaced by a ≥44px `Select`; choosing a section navigates (deep-link/back works) | Positive | ☐ | A1 |
| RSP-03.3 | User tabs | Desktop/Tablet | Open a user detail | 7 underline tabs scroll horizontally if needed | Positive | ☐ | |
| RSP-03.4 | User Select | Mobile | Open a user detail | Tabs → `Select`; switching shows the right panel (Profile…Activity) | Positive | ☐ | A1 |
| RSP-03.5 | Drill-down is a page | Mobile | Tap a user card → detail → browser Back | Detail is a real **page** (URL changes, Back returns to the list — not a stacked blade) | Positive | ☐ | |

## RSP-04 — Dialogs full-screen on mobile

**Requirement.** Centered modal dialogs go (near-)full-screen on mobile with ≥44px footer
actions; desktop/tablet keep the centered, width-capped modal. *(DESIGN-SPEC §2.6; note the
`max-sm`/640 boundary.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ____________

| TC | Title | Tier | Steps | Expected result | Type | Status | Notes |
|----|-------|------|-------|-----------------|------|--------|-------|
| RSP-04.1 | Centered modal | Desktop/Tablet | Open Create tenant / Create user | Centered modal, width-capped (`max-w-md`/`-lg`), backdrop visible | Positive | ☐ | |
| RSP-04.2 | Full-screen modal | Mobile | Open the same dialog | Dialog fills the viewport (full width + height, no rounded corners/border), body scrolls | Positive | ☐ | A4 |
| RSP-04.3 | Footer targets | Mobile | Measure Cancel / submit buttons | Footer action buttons ≥44px tall | A11y | ☐ | A1 |
| RSP-04.4 | Edit / picker dialogs | Mobile | Open Edit tenant, Edit user, Assign departments | Same full-screen + ≥44px treatment | Positive | ☐ | |
| RSP-04.5 | Global dept/prompt dialogs | Mobile | `/departments` → New department / New prompt / View prompt | Full-screen on mobile (closed in the 2026-06-30 review pass) | Positive | ☐ | |
| RSP-04.6 | Boundary 639↔640 | Mobile/Tablet | Resize across 640px with a dialog open | Full-screen ≤639; centered ≥640 (documented `max-sm` edge) | Edge | ☐ | |
| RSP-04.7 | Long-tail (known gap) | Mobile | Open an `AlertDialog` confirm (e.g. Disable tenant) | **Known backlog** — `AlertDialog`-based confirms not yet full-screen; mark `NA`/log against README §7 | Edge | ☐ | not a defect |

## RSP-05 — Dashboards / KPI grids reflow

**Requirement.** KPI/stat grids and charts reflow 4-up → 2-up → 1-up with no clipping; the
shared `Table` scrolls horizontally rather than overflowing the page. *(DESIGN-SPEC §2.5.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ____________

| TC | Title | Tier | Steps | Expected result | Type | Status | Notes |
|----|-------|------|-------|-----------------|------|--------|-------|
| RSP-05.1 | Platform dashboard KPIs | All | `super_admin` → `/dashboard` | KPI cards 4-up (desktop) → 2-up (tablet) → 1-up (mobile); chart width-responsive | Positive | ☐ | cross-ref P1 |
| RSP-05.2 | Monitoring | All | `/system-health` | KPI grid reflows; paired tables stack at tablet/mobile | Positive | ☐ | A4 |
| RSP-05.3 | Tenant overview | All | A tenant → Overview tab | KPI tiles + activity reflow; no clipping | Positive | ☐ | |
| RSP-05.4 | Table scroll | Mobile | Any 4+ column table (e.g. Prompts, MetricTable) | Table scrolls **inside its card** horizontally; page itself doesn't overflow | Edge | ☐ | A4 |

## RSP-06 — Accessibility & cross-cutting (WCAG 2.2 AA)

**Requirement.** Every primary touch target ≥44px on mobile; visible focus on keyboard nav;
dark-mode parity; reflow holds in portrait + landscape. *(Rules `11-ux-ui-principles.mdc`;
WCAG 2.2 AA.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ____________

| TC | Title | Tier | Steps | Expected result | Type | Status | Notes |
|----|-------|------|-------|-----------------|------|--------|-------|
| RSP-06.1 | Touch-target audit | Mobile | Measure hamburger, header actions, FAB, pager arrows, `Select` trigger, dialog footer buttons, card tap row | All ≥ 44×44px (card row `min-h-14` = 56px) | A11y | ☐ | A1 |
| RSP-06.2 | Keyboard focus | Desktop | Tab through shell, grid, dialog | Visible focus ring (`--ring`) on every interactive element; logical order | A11y | ☐ | A2 |
| RSP-06.3 | Drawer focus trap | Mobile | Open drawer; Tab; Esc | Focus stays within drawer; Esc closes and restores focus to the hamburger | A11y | ☐ | A2 |
| RSP-06.4 | Dark mode parity | All | Toggle theme on each tier | Layouts identical; semantic tokens hold contrast; no hardcoded colors leak | A11y | ☐ | A3 |
| RSP-06.5 | Orientation | Tablet/Mobile | Rotate portrait ↔ landscape | Layout reflows cleanly; no loss of content/function | A11y | ☐ | A5 |
| RSP-06.6 | No horizontal scroll | All | Scan each surface at each width | The page never scrolls horizontally (only intended inner table scroll) | Edge | ☐ | A4 |

---

## 4. Defect reporting

Use the central template (`docs/qa/manual-tests/README.md` §8). Tag responsive-layout defects
with the **TC ID** (e.g. `RSP-02.3`) and the responsive-local flag (`A1`–`A5`) or `X1`. For a
flow that fails on its **data** behavior (not the responsive layer), file it against the
matching central case (`MT-*`/`UAC-*`) instead — this suite asserts the **responsive layer** only.
