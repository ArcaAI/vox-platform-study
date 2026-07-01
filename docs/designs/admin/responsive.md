> _Relocated from `docs/implementation/TASK-384-Responsive-Admin-Surfaces/DESIGN-SPEC.md` (TASK-385 docs alignment)._

# TASK-384 · Responsive Admin Surfaces — Design Spec (Desktop / Tablet / Mobile)

> **What this is:** the authoritative **Desktop / Tablet / Mobile** reference for the
> admin console's *responsive model*. TASK-384 is the **cross-cutting** pass: it does
> not own any one surface, it owns the **transformation rules** that every other admin
> surface (TASK-379–383, tenant detail) inherits at tablet and mobile.
>
> **Grounded in** (no live Figma this session — node ids only, per
> [E2E-AND-QA-CONVENTIONS.md](../../qa/E2E-AND-QA-CONVENTIONS.md) §2):
> - foundation **`07 · Responsive — Tablet & Mobile`** `62:1082`
>   (`screenshots/foundation-16-responsive.png`)
> - foundation **`06 · Multi-Tenancy & Impersonation`** `61:985`
>   (`screenshots/foundation-15-multitenancy.png`)
> - the TASK-371 responsive narrative ([README §5.4](../../implementation/TASK-371-Admin-Console-Redesign/README.md), §5.12–5.14)
> - semantic tokens only — [`theme.css`](../../implementation/TASK-371-Admin-Console-Redesign/theme.css)
> - design rules [`11-ux-ui-principles.mdc`](../../../.cursor/rules/11-ux-ui-principles.mdc),
>   [`10-skeleton-loading.mdc`](../../../.cursor/rules/10-skeleton-loading.mdc)

---

## 1. Breakpoint model (authoritative)

Tailwind defaults, anchored to the design frames. The shell uses pure CSS variants
where possible; the table→card and tabs→Select switches need a runtime signal
(`useBreakpoint()` — `hooks/use-breakpoint.ts`) because the grid is virtualized with
pixel column widths and we don't want to mount both tab UIs.

| Tier | Range | Tailwind | Shell | Tables / grids | Detail tabs | KPI / card grid |
|---|---|---|---|---|---|---|
| **Mobile** | `< 768` | `< md` (`max-md:`) | App-bar + hamburger → modal drawer (bottom tenant switcher) | **Card-list** + FAB | **`Select`** | 1-up |
| **Tablet** | `768 – 1023` | `md` | **Icon-rail** (`w-16`, icons only) | **Condensed** table (low-priority columns hidden) | Scrollable underline tabs | 2-up |
| **Desktop** | `≥ 1024` | `lg` | Full sidebar (`w-64`, icon + label) | Full `VirtualizedDataGrid` | Horizontal underline tabs | 4-up |

> **One nuance — the dialog full-screen boundary is `sm` (640), not `md` (768).** The
> shared `MOBILE_DIALOG_CONTENT` fragment (`lib/responsive.ts`) goes full-screen at
> `max-sm:` (`< 640`), one step tighter than the shell/grid `md` boundary. Rationale:
> a centered shadcn modal at 640–767px is still comfortable, and `sm` is shadcn's own
> dialog breakpoint (`sm:max-w-lg`), so the override stays inside the primitive's grain.
> The 768–639 band therefore shows the **centered** dialog with desktop nav already in
> drawer mode. This is intentional; flagged here so QA doesn't file it as a defect.

Cross-cutting invariants (all tiers): semantic tokens only (no hardcoded color/spacing),
WCAG 2.2 AA, **≥ 44px** primary touch targets on mobile (`2.5.8 Target Size`), dark mode
parity, and **no feature/data/desktop-behavior change** — this pass is layout-only.

---

## 2. Frame `07 · Responsive — Tablet & Mobile` `62:1082`

The frame renders **one shell** across four captured states: *Tablet 768 · icon-rail +
condensed table*, *Mobile 360 · app-bar + card-list + FAB*, *Mobile 360 · nav drawer +
tenant switch*, and *Mobile 360 · blade drill-down + impersonation*. Each surface class
below maps that frame to the shipped code.

### 2.1 Application shell — `components/layout/app-shell.tsx`

**Desktop (`≥ lg`).** Full fixed sidebar `w-64` on `bg-sidebar` / `border-sidebar-border`:
brand mark (icon + "HOPE / Admin Console"), section-grouped nav (icon + label, active =
`bg-sidebar-accent` / `text-sidebar-accent-foreground`), and the **full** working-tenant
switcher pinned to the sidebar footer. Topbar = breadcrumbs left, theme/density/user
actions right (`size-9` icon buttons).

**Tablet (`md`).** Sidebar collapses to an **icon-rail `w-16`** (frame state 1, dark rail):
`BrandMark`/`SidebarNav` take a `rail` prop that centers icons and hides labels + section
titles (`hidden lg:block`); every rail item keeps `aria-label`/`title` so the icon-only
nav stays screen-reader- and tooltip-accessible. The footer switcher renders its
**`collapsed`** (avatar-only) variant. Content area is unchanged; the data grid renders
its **condensed** column set (§2.3).

**Mobile (`< md`).** Sidebar is `hidden`; the topbar becomes an **app-bar** with a
hamburger (`Menu`, `size-11`) that opens a **modal nav drawer** (`Sheet`, `side="left"`,
`w-[86vw] max-w-80`, scrim built-in) — frame state 3. The drawer shows the **full** nav
(labels visible) and pins the **full working-tenant switcher at the bottom** (the design's
"bottom tenant switcher"). Header actions grow to `size-11` (44px) via `max-md:size-11`.

| Aspect | Desktop ≥1024 | Tablet 768–1023 | Mobile <768 |
|---|---|---|---|
| Sidebar | `w-64` full | `w-16` icon-rail | hidden → `Sheet` drawer |
| Nav labels | visible | hidden (icon + `aria-label`) | visible (in drawer) |
| Tenant switcher | full, sidebar footer | collapsed avatar, rail footer | full, drawer bottom |
| Header actions | `size-9` | `size-9` | **`size-11` (≥44px)** |
| Touch targets | mouse | rail icons ≥40px | hamburger + actions ≥44px |

### 2.2 Working-tenant switcher — `features/tenants/working-tenant-switcher.tsx` *(also frame `06`)*

- **Desktop / drawer:** full control — avatar + 2-line `Acme Health / Working tenant` +
  `ChevronsUpDown`; super-admins open a `Popover` + `Command` (search · **All tenants /
  cross-tenant** · tenant list w/ current ✓ · *Manage tenants*); tenant-admins see a
  static avatar chip.
- **Tablet (rail):** **`collapsed`** — avatar-only, centered; super-admin keeps the
  interactive popover trigger (label via `title`), tenant-admin a static avatar. This is
  the design's "collapsed sidebar-footer control" (frame `06`, *Working-tenant switcher ·
  Collapsed*).
- **Mobile:** the **full** switcher sits at the **bottom of the nav drawer** (frame `07`
  state 3: *"Acme Health · Working tenant · tap to switch"*).

### 2.3 Data grids → condensed table → card-list — `features/data-grid/responsive-data-grid.tsx`

App-level wrapper over the shared `VirtualizedDataGrid` (so `packages/ui` and
`ui-playground` are untouched). Owns the table↔card transform for **Tenants**, **Users**,
and **Tenant Users**.

**Desktop.** `VirtualizedDataGrid` unchanged — all columns, server/client sort · filter ·
faceted search · column visibility/resize/reorder · density · page-size, layout persisted
to the user profile.

**Tablet.** Same grid, but columns filtered by `selectCondensedColumns(columns,
condensedColumnIds)` — lower-priority columns drop (order preserved), so the table fits
without horizontal scroll (frame state 1: Name · Role · Status only). Per-surface keep-lists:
Tenants `['name','key','resourceStatus']`, Users `['username','email','resourceStatus']`,
Tenant Users `['username','roleId','resourceStatus','actions']`.

**Mobile.** A self-contained **card-list** (`<ul>/<li>` tap-through, frame state 2): leading
`Avatar`, `title`, `subtitle`, optional `meta` (role/departments), trailing **status badge**
+ **chevron** when the row is tappable; row `actions` (kebab) render outside the tap target.
Includes: a full-width search (`h-11`; bound to server `queryState.globalSearch` or a client
`mobileFilter`), a `from–to of total` pager with `size-11` prev/next, and an optional
**FAB** (`size-14 rounded-full` fixed bottom-right) for the primary action. The matching
desktop primary button is hidden on mobile (`max-md:hidden`) so the FAB is the single CTA.

| Aspect | Desktop | Tablet | Mobile |
|---|---|---|---|
| Display | full grid | condensed grid | card-list |
| Columns | all | `condensedColumnIds` | avatar/title/subtitle/meta/badge |
| Search | grid toolbar | grid toolbar | `h-11` field (server or client) |
| Pagination | grid pager | grid pager | `from–to of total` + `size-11` arrows |
| Primary action | header button | header button | **FAB ≥44px** |
| Row open | `onRowClick` | `onRowClick` | card `onClick` → route, chevron affordance |

### 2.4 Detail pages → tabs → `Select` — tenant detail + user detail

Frame `07` state 4 ("blade drill-down · user detail") is realized as a **full page route**
(`$tenantId/users/$userId`) reached by tapping a card, not a stacked blade — consistent
with TASK-371 §5.12's page-over-blades decision. Sub-section nav transforms:

- **Desktop / Tablet (`md:flex`):** horizontal underline tabs (`overflow-x-auto`,
  active = `border-primary` + `text-foreground`).
- **Mobile (`md:hidden`):** an `h-11` shadcn **`Select`** listing the same sections.
  - Tenant detail (`$tenantId/route.tsx`) derives the active tab from the pathname and
    `navigate`s on change (deep-link safe).
  - User detail (`$tenantId/users/$userId.tsx`) binds the `Select` to local tab state
    across its 7 panels.

> **Impersonation** (frame `07` state 4 primary action + frame `06`) is **design-only** and
> **out of TASK-384 scope** — it is a multi-tenancy/auth feature, not a responsive
> transform. The page renders Edit / status actions; the *Impersonate user* CTA and the
> app-wide indigo (`--ai`) impersonation banner remain a TASK-371 backlog item.

### 2.5 Dashboards / KPI grids — reflow only (no JS)

Verified to already reflow with pure Tailwind, so TASK-384 added **no code** here:

- KPI/stat grids: `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4` (1 → 2 → 4-up).
- Charts: fixed height, responsive width.
- `system-health` paired tables stack at `lg:grid-cols-2`.
- The shared shadcn `Table` already wraps in `relative w-full overflow-x-auto`, so any
  bespoke 4-column table (e.g. `MetricTable`, global Departments/Prompts) scrolls
  horizontally on mobile without modification — honoring the surgical constraint.

### 2.6 Dialogs → full-screen on mobile — `lib/responsive.ts`

**Desktop / Tablet:** centered shadcn modal at its width (`sm:max-w-md` / `-lg` / `-2xl`).

**Mobile (`< sm`):** compose `MOBILE_DIALOG_CONTENT` after the width class →
`max-sm:h-dvh max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0
max-sm:overflow-y-auto` fills the viewport; `MOBILE_DIALOG_FOOTER`
(`max-sm:[&>button]:h-11`) / `_DEEP` (`[&_button]`) grow footer actions to **≥44px**.
Applied to the high-traffic mutation dialogs: tenant form, user create, user edit,
department form, checkbox picker. Long-tail dialogs are tracked in README §7.

### 2.7 Loading / empty / error (per `10-skeleton-loading.mdc`)

The mobile card-list mirrors the loaded shape with `<Skeleton>` (avatar + 2 lines + badge,
6 rows), an **empty state** (icon + title + description, or a passed `emptyState`), and an
**error state** (`role="alert"`, `TriangleAlert`, message, `h-11` Retry). Never a spinner
or bare "Loading…". Tablet/desktop reuse the grid's own states.

---

## 3. Frame `06 · Multi-Tenancy & Impersonation` `61:985` — responsive bits

This frame is owned by TASK-371/379; TASK-384 inherits only its **responsive placement**
of tenant context. The two pieces that move across breakpoints:

1. **Working-tenant switcher** — collapsed (rail) ↔ full (desktop footer / drawer bottom);
   see §2.2. The popover/`Command` content is breakpoint-agnostic.
2. **"Acting on: «Tenant»" banner** + **NoTenant empty state** — render inside the content
   column, so they inherit the page's reflow (full-width → stacked) with no extra rules;
   the banner text wraps and its *Change* affordance stays ≥44px tappable on mobile.

Out of responsive scope (design-only / other tickets): cross-tenant topbar pill,
impersonation confirm dialog, and the app-wide impersonation banner.

---

## 4. Token & accessibility ground

| Concern | Token / rule |
|---|---|
| Sidebar surfaces | `--sidebar`, `--sidebar-foreground`, `--sidebar-border`, `--sidebar-accent(-foreground)`, `--sidebar-ring` |
| Primary / focus | `--primary`, `--primary-foreground`, `--ring` (focus-visible rings on all interactive els) |
| Cards / content | `--card`, `--background`, `--muted-foreground` |
| Impersonation "mode" (future) | `--ai` indigo — never a health-status color |
| Touch target | ≥44px on mobile primaries (hamburger, header actions, FAB, pager, Select trigger, dialog footer) — WCAG 2.2 AA 2.5.8 |
| Contrast / dark mode | semantic tokens carry light+dark; no hardcoded hex |

---

## 5. Figma frames

**Figma frames (created 2026-06-30).** Connected file **HOPE-Admin-Console** (`fileKey unsaved-mr0qkre2-nzazl7ou`). Structural/representative shell-pattern frames grounded in the desktop `07 · Responsive — Tablet & Mobile 62:1082`, placed in a dedicated responsive band on the same page:

| Frame name | Platform | Node ID |
|---|---|---|
| `TASK-384 · 07a App Shell — Tablet (icon-rail)` | Tablet (834) | `194:521` |
| `TASK-384 · 07b App Shell — Mobile (nav drawer)` | Mobile (390) | `194:522` |

The Tablet frame shows the `w-64 → w-16` icon-rail (labels → tooltips, collapsed tenant avatar at the rail footer, `size-9` header actions). The Mobile frame shows the app-bar + hamburger → modal nav **drawer** over a built-in scrim, with **full** role-tiered nav sections (Platform / Observability / Identity & Access) and the **bottom tenant switcher**. Per-concrete-surface responsive variants remain deferred below (several are now drawn under their own tickets — TASK-372/379/380/381/382/383).

### Still deferred

`07 · Responsive` and `06 · Multi-Tenancy` are **pattern** frames (one shell, a few example
states). They do **not** yet contain dedicated Tablet/Mobile variants per concrete surface.
Deferred to a serialized Figma pass once a file is connected (screenshots/visual alignment
come later — this session is node-id-grounded only):

1. **Tenants list** — Tablet condensed grid + Mobile card-list + FAB (currently inferred
   from the generic Users example in `07`).
2. **Tenant Users** — Mobile card-list with per-row kebab + bulk-bar behavior at mobile.
3. **Tenant Detail** — Mobile `Select` sub-nav for Overview/Users/Configuration/Storage/
   Departments (only the Users example is drawn).
4. **User Detail** — Mobile `Select` across all 7 panels (frame shows the static drill-down,
   not the `Select`).
5. **Platform Dashboard / Monitoring** — Tablet (2-up) + Mobile (1-up) KPI/chart reflow frames.
6. **Dialog · mobile full-screen** — a dedicated full-screen mobile dialog frame (tenant/user
   form) showing the `h-dvh` sheet + ≥44px footer.
7. **Mobile nav drawer** — a production-nav variant (the frame's drawer shows an illustrative
   5-item nav, not the shipped role-tiered `getNavSections` set).
8. **Impersonation (responsive)** — if/when impersonation ships, its mobile banner + confirm
   dialog variants.
