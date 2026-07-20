# HOPE Admin Console — Standardized Data Grid UX/UI Specification

**Scope:** the canonical list/table surface for ~25 admin-console screens, built on `VirtualizedDataGrid` (`packages/ui/src/components/data-grid/`). This spec is decision-oriented — where the current code already does the right thing it is affirmed; where it diverges from the requirements a **Δ (delta)** flags the change. It uses only shadcn primitives that exist in `packages/ui/src/components/shadcn/` and semantic tokens from `packages/ui/src/styles/globals.css`. Internal tool → **favor density and utility**.

## 0. Design decisions at a glance

| # | Decision |
|---|---|
| D1 | Three stacked regions in one flex-column `<section>`: **Toolbar/Filters** (shrink-0) → **Grid frame** (flex-1, min-h-0) → **Pagination** (shrink-0, one line). |
| D2 | **Fill-height** by default (flex-fill chain, not `calc()`). Fixed pixel height only for embedded grids (detail tabs, cards). |
| D3 | Responsiveness driven by **container queries** on the grid root (`@container`), thresholds mapped 1:1 to Tailwind's `sm/md/lg/xl` numbers — so a grid degrades to its *own* width, correct whether the sidebar is open or collapsed. |
| D4 | Two filter entry points, one state: **toolbar chips** for the 2–4 hot fields + **column-header "Filter…"** for every filterable column. |
| D5 | **Single-sort default, multi-sort via Shift-click** (backend `sort` CSV already supports it). |
| D6 | Offset pager = **first/last + ellipsis + current±2 numbered window**; cursor pager = **Prev/Next only, "of many"** total rule. |
| D7 | **Personalization** (order, size, visibility, pinning, density) persists **server-side per user per grid**; **query** (search, filters, sort, page, limit) lives in the **URL** (nuqs). |
| D8 | Gate first grid paint on `isLayoutReady` (or SSR-inject the layout) to kill the personalization flash. |

---

## A. Region anatomy & layout

The grid is one landmarked section that owns its height. Region order and composition:

```
<section aria-label="Tenants" data-density>         // flex min-h-0 flex-1 flex-col gap-3, @container
 ┌ REGION 1 — Toolbar / Filters ───────────────────┐  shrink-0
 │ [🔍 omni search] [+Status][+Plan] [Clear] · · ·  │
 │ · · ·                 [density] [View ▾]          │
 ├ REGION 2 — Grid frame ───────────────────────────┤  flex-1 min-h-0, rounded-md border, overflow-hidden
 │ ┌ scroll container (h-full, overflow-auto) ────┐ │
 │ │ ▓ header rowgroup  sticky top-0 z-20 bg-card ▓│ │
 │ │   virtual body rows (role=row) …             │ │
 │ └──────────────────────────────────────────────┘ │
 ├ REGION 3 — Pagination ───────────────────────────┤  shrink-0, ONE line, min-h-11
 │ Showing 1–25 of 480   Rows:[25]  « ‹ 1…6[7]8…20 › »│
 └──────────────────────────────────────────────────┘
</section>
```

**Composition & spacing (8-pt grid):**

| Region | Structure | Spacing / sizing |
|---|---|---|
| 1 Filters | `DataGridToolbar` — omni `Input` left; filter chips; `Clear filters` ghost `Button`; right cluster = density `Button` (icon) + `View` `Popover` | Row gap `gap-2`; region→region `gap-3` (12px). Controls `h-8` desktop, `h-9`+ on coarse pointers. |
| 2 Grid frame | `role="grid"` wrapper (`rounded-md border overflow-hidden`) → scroll container → sticky header rowgroup + virtual body rowgroup | Cell padding `px-3`; row height = density token (`DENSITY_ROW_HEIGHT`: comfortable **48**, compact **36**). Header row uses the same token. |
| 3 Pagination | `nav[aria-label="Pagination"]` — status (left) · page-size `Select` · numbered window (right) | `min-h-11` (44px), `gap-4`, `justify-between`, `whitespace-nowrap`, never wraps. |

**Sticky behavior (affirm + Δ):** header rowgroup stays `sticky top-0 z-20 bg-card border-b` (already implemented). **Δ** add a scroll-driven bottom shadow on the header (`shadow-[0_1px_0_0_var(--border)]` → elevate to a soft shadow once `scrollTop > 0`) so the pinned header reads as a layer over scrolling rows.

**Page-height strategy (the call — D2):** use a **flex-fill chain**, not a viewport `calc()`, because the inset has variable-height banners (`ImpersonationBanner`, `WorkingTenantBanner`) above the content.

- The console content wrapper `apps/admin-console/src/app/(console)/layout.tsx` is already `flex flex-1 flex-col p-4 md:p-6`. **Δ** add `min-h-0` and make the `SidebarInset` region the scroll boundary (`h-svh overflow-hidden` on the inset) so the **only** scroll is the grid body — not the window.
- List screens render their root as `flex min-h-0 flex-1 flex-col gap-4` (PageHeader `shrink-0`, grid `flex-1 min-h-0`).
- **Δ** `VirtualizedDataGrid` gains a fill mode: when `height` is unset (new default for admin list pages) the root is `flex min-h-0 flex-1 flex-col` and the scroll container is `h-full` instead of `style={{height:480}}`. Keep the numeric `height` prop for embedded/fixed cases.

Net result on desktop: PageHeader + toolbar + pagination are fixed; only rows scroll, under a sticky header, filling the viewport with zero window scroll.

---

## B. Responsive behavior per breakpoint

Implement with **container queries** (`@container` on the grid root; Tailwind v4 `@sm/@md/@lg/@xl`). Base (small container) = collapsed; larger thresholds progressively **restore** inline chrome. Thresholds equal the viewport numbers the brief names (sm 640 / md 768 / lg 1024 / xl 1280). Desktop-first tool → the default admin viewport lands at `@lg`/`@xl` (everything inline).

### B1. Filters region

| Container width | Omni search | Filter controls | Density / View |
|---|---|---|---|
| **≥ lg (1024)** | `Input` fixed `w-64` (grows to `lg:w-56`+) | All hot-field chips inline (dashed `+ Field` buttons) | Density toggle + `View` `Popover` inline |
| **md–lg (768–1024)** | `Input` flexes to fill (`flex-1 min-w-40`) | Chips beyond the first **collapse into one `Filters` `Button`** (`SlidersHorizontal` icon) with a `Badge` = active-filter count, opening a **`Popover`** listing all filters | Stay as icon-only `Button`s |
| **< md (768)** | Full-width row (`w-full`), always visible | The `Filters` `Button` (+ badge) opens a **`Sheet`** (`side="bottom"`), not a Popover — more room + touch-friendly; contains every filter grouped by column | `View` + density move **into the Sheet** under "Columns" / "Density" sections; toolbar shows only `[search][Filters ⋯]` |

The omni search **never disappears** (primary affordance) — it only resizes. Active-filter count is always visible on the `Filters` button so collapsed filters are never "lost."

### B2. Pagination region — drop from the ends inward to hold ONE line

| Container width | Status text | Page-size `Select` | Navigator |
|---|---|---|---|
| **≥ xl** | `Showing 1–25 of 480` | visible, label "Rows per page" | `«  ‹  1 … 6 [7] 8 … 20  ›  »` (first/last + ellipsis + **current±2**) |
| **lg–xl** | `Showing 1–25 of 480` | visible | drop `« »`; keep `‹ … ±2 … ›` |
| **md–lg** | `1–25 of 480` (drop "Showing") | visible, label hidden (`[25]` only) | window shrinks **±2 → ±1** (`‹ 6 [7] 8 ›` + first/last numbers/ellipsis) |
| **sm–md** | `25 of 480` (shown/total) | compact `[25]` | numbers off → `‹ Prev · Page 7 of 20 · Next ›` |
| **< sm** | `7 / 20` (page form) | collapses into the overflow / Sheet | `‹ ›` icon-only, 44px touch targets, `aria-current` on the page text |

Status uses `tabular-nums` + a reserved `min-w` so digit changes never shift layout. **Δ** the current pagination's left slot shows *selection count* ("N of M row(s) selected") — that moves to the selection action bar (§G); the status line shows the **item range** the brief requires.

### B3. Body

- **Horizontal scroll:** grid frame `overflow-hidden`, scroll container `overflow-auto` (both axes). Below the sum of min column widths, the body scrolls horizontally; header and pinned columns scroll in lockstep (they share the scroll container).
- **Pinned-column affordance (Δ):** wire `getColumnPinningStyle({ column, withBorder: true })` (the border arg exists in `packages/ui/src/lib/data-table.ts` but is never passed today) so the last left-pinned / first right-pinned cell shows the inset divider shadow — **only when horizontally overflowing** (toggle via scroll state), else it's visual noise. Pinned cells use `bg-inherit` so a selected row's `bg-accent` shows through the pinned column instead of the hardcoded `var(--background)`.
- **Min column widths:** enforce `minSize` per `ColumnDef` — select `40`, actions `56`, IDs/text `120–160`, badges/enums `96`, timestamps `140`. Default `minSize: 80`, `size: 160`.
- **Touch:** on `(pointer: coarse)`, force **comfortable** density (compact 36px is below the 44px floor) and enlarge pager/handle hit areas to ≥44px.

---

## C. Column interaction spec

| Interaction | Control & where it lives | Pointer behavior | Keyboard / non-pointer alternative (WCAG 2.5.7) |
|---|---|---|---|
| **Resize** *(Δ: handle UI missing today — resizing is enabled in `useReactTable` but no grabber is rendered)* | A `role="separator"` grabber on each header cell's right edge (`absolute right-0 h-full w-1 cursor-col-resize`), hit area padded to ≥24px | Hover → `bg-border`; active/`isResizing` → `bg-primary`. **Double-click = reset that column** (`column.resetSize()`) — the pragmatic "auto-fit" for admin grids | Separator is focusable (`tabIndex 0`, `aria-orientation="vertical"`, `aria-label="Resize {col}"`, `aria-valuenow/min/max`). ←/→ ±16px, Shift+←/→ ±48px, Home/Enter reset |
| **Reorder** | `GripVertical` drag handle `<button>` in the header (visible on hover/focus), dnd-kit `useSortable` (already wired) | Drag within `restrictToHorizontalAxis` | **Header menu "Move left" / "Move right"** items (`moveColumn` neighbor swap) — primary a11y path; dnd-kit `KeyboardSensor` (Space pick up, arrows, Space drop, Esc cancel) is secondary |
| **Pin left/right** | `DataGridColumnHeader` `DropdownMenu` (Pin left / Pin right / Unpin — already implemented) | — | Menu items are standard focus stops |
| **Visibility** | Toolbar **`View` `Popover`** with `Command` search + checkboxes (already implemented) | Toggle per column; enforce ≥1 visible hideable column (already enforced in `use-data-grid.ts`) | Full keyboard via `Command` |
| **Reset layout** *(Δ: does not exist)* | **`Command` footer item "Reset to default layout"** (`RotateCcw`) inside the `View` popover, mirrored in the overflow menu | Resets order/size/visibility/pinning/density to coded defaults **and** clears the persisted record | Focusable item; announces "Layout reset" |

Pinned columns also render a small pin glyph in the header. Naming discipline (Δ): the toolbar's existing **"Reset"** (clears filters + search) is renamed **"Clear filters"** so it is never confused with **"Reset layout"** (clears personalization). Two affordances, two scopes (see §I).

---

## D. Per-type filter UX

**Placement (D4):** the 2–4 highest-value fields per grid render as **toolbar chips** (the existing dashed `+ Field` `Button` → `Popover`). **Every** filterable column is also reachable from its **header menu → "Filter…"**, which opens the *same* control. Below `md`, chips collapse into the `Filters` button → `Popover`/`Sheet` (§B1).

**Operator sets are trimmed for admins** (subset of `packages/ui/src/config/data-table.ts`) — expose the rare operators only when a grid opts in.

| Data type | Control (shadcn) | Operators exposed (default) | Active indication |
|---|---|---|---|
| **text** | operator `Select` + `Input` | **Contains** (default), Is, Is empty / Is not empty | chip shows truncated value |
| **number** | operator `Select` + numeric `Input`(s) | =, <, >, **Between** (two inputs), Is empty | chip shows `> 100` etc. |
| **date / datetime** | `Popover` + **`Calendar`** (single or `mode="range"`) + operator `Select` | On, Before, After, **Between**, **Relative to today** (presets: Today / Last 7 / 30 / 90 days). `datetime` variant adds a time `Input` | chip shows formatted date/range |
| **enum / select** | `Command` single-select checklist (existing faceted) | implicit **Is** | chip shows selected label |
| **multi-select** | `Command` multi-checkbox + count `Badge` (existing) | **Has any of** (default), Has none of | count `Badge` on the chip |
| **boolean** *(Δ: no dedicated UI today — falls through to a text input)* | 3-state `Select` **Any / Yes / No** (or domain labels via `meta.options`), or a `ToggleGroup` | Any = filter off | chip shows `Yes`/`No` |

**Active-filter indication & clear-all:** filtered columns show a filled **filter glyph** in the header; each chip shows its value + `×`; the toolbar shows the total active count (on the collapsed `Filters` button as a `Badge`). **Clear-all** = the `Clear filters` ghost `Button` (visible only when `filters.length || globalSearch`), plus per-popover "Clear filter" and per-chip `×`.

---

## E. Sorting UX

- **Single-sort by default; multi-sort via Shift-click** (D5). The backend contract already serializes multiple keys (`sort=field:asc,field2:desc` in `toPaginatedQuery`), and `DataQueryState.sorting` is an array, so multi-sort is nearly free — but it stays opt-in per interaction to avoid confusing the common case.
- **Header click cycles asc → desc → none** (3-state, discoverable); the header `DropdownMenu` offers explicit **Asc / Desc / Reset** (already implemented). Shift-click appends/toggles a column in the sort list.
- **Indicators:** `ChevronUp` / `ChevronDown` / `ChevronsUpDown` (already present). For multi-sort, a small **priority number** (`1`, `2`, `3`) sits next to the arrow.
- **Semantics:** `aria-sort="ascending|descending|none"` on each `role="columnheader"` (already set). Sort changes announce via the live region: *"Sorted by Name, ascending."*

---

## F. Pagination UX — exact one-line spec

**Offset variant (default).** `nav[aria-label="Pagination"]`, `flex items-center justify-between gap-4 min-h-11 shrink-0`, never wraps.

- **Status** (`aria-live="polite"`, `tabular-nums`): `Showing {first}–{last} of {total}` where `first = page*limit+1`, `last = min((page+1)*limit, total)`. `0` rows → `No results`.
- **Page-size `Select`:** **standardize on `[25, 50, 100]`, default 25** (Δ: unifies the grid's `[10,20,50]` with the app's `[25,50,100]`). Label "Rows per page" hidden < md.
- **Numbered window rendering rules** (`p` = page+1, `N = max(1, pageCount)`, radius `r` responsive per §B2):
  1. Always render page **1** and page **N** as buttons (when `N > 1` and `r ≥ 1`).
  2. Render the clamped window `[p-r, p+r]`.
  3. Insert a non-interactive `…` when there's a gap (`windowStart > 2` and/or `windowEnd < N-1`); if the gap is a single page, render that page instead of `…`.
  4. Current page: `aria-current="page"`, solid (`variant=default`); others `variant=ghost/outline`, `size-8 min-w-8 tabular-nums`.
  5. `« »` (first/last) only ≥ xl; `‹ ›` (prev/next) always; disabled at bounds.
  6. `r = 0` (< sm): hide numbers → `‹ Prev · Page p of N · Next ›`. `N == 1`: numbers hidden, prev/next disabled, status + page-size remain.
  - Example (page 7 / 20, xl): `«  ‹  1 … 5 6 [7] 8 9 … 20  ›  »`.
  - **Decision:** first/last + ellipsis is the default (better jump-to-ends UX) and still surfaces the required current±2 neighborhood; a strict "±2 only, no ends" mode is a feature flag, not the default.

**Cursor variant** (audit logs / deep scans — keyset): **no numbered window** (offsets are meaningless). Status = `Showing {shown} rows`; **total rule** → when total is absent/huge show `1–25 of many` (never fabricate a count); if the server returns an estimate, show `≈ 12,480`. Navigator = `‹ Prev / Next ›` only; Prev enables once a client cursor stack exists (today Prev is inert — keep disabled until TASK-373 lands the server cursor contract, per `types.ts` D7 note).

**Loading behavior (no layout shift):** keep the pager **mounted and stable** on every fetch — do **not** swap it for a skeleton. On page/sort/filter change, disable the navigators, set `aria-busy`, keep the last-known status text (optionally a tiny inline `Spinner`), and render **row skeletons in the body at the current page size** so region heights are unchanged. Page-size `Select` stays enabled (it triggers the next fetch). Reserve status width with `tabular-nums` + `min-w` → zero CLS.

---

## G. States

| State | Treatment |
|---|---|
| **Initial loading** | Real toolbar + pagination chrome rendered **disabled** (no flash), body = `DataGridSkeleton` mirroring column count (`packages/ui/.../data-grid-skeleton.tsx`). |
| **Refetch / query change** | Chrome stays; body shows row skeletons (count = page size) with fixed heights; background refetch of the *same* query keeps stale rows dimmed + `aria-busy` rather than flashing skeletons. |
| **Empty — no data** (no filters/search active) | `Empty` component family: domain icon + "No {things} yet" + **primary CTA** (e.g. "New tenant"). |
| **Empty — no results** (filters/search active) | `Empty`: filter-off icon + "No results match your filters" + **"Clear filters"** button. Distinguished by whether `queryState` has any filter/search. |
| **Error** | Nothing shown yet → block `role="alert"` in the body (`TriangleAlert` + message + `Retry`, already implemented). Rows already present + refetch failed → **stale-data `ErrorBanner` above the grid** (mirrors the admin `DataTable` behavior), rows kept, pager visible-but-disabled. |
| **Personalization loading (D8, Δ)** | **Gate the first body paint on `isLayoutReady`** — while the persisted layout resolves, render `DataGridSkeleton` (not the default-layout grid) so the first real paint already uses the resolved order/size/visibility/pinning. Best path: the Next server component reads user settings and passes them as the initial layout (**zero flash**); client-only fallback = skeleton-gate on `isLayoutReady`. Today the grid renders defaults immediately and never reads `isLayoutReady` on the render path — this is the fix. |

---

## H. Accessibility annotations (WCAG 2.2 AA)

**Grid semantics:** keep `role="grid"` + `aria-rowcount` (incl. header), `aria-colcount`, `role="row"`/`aria-rowindex`, `role="columnheader"`/`aria-sort`, `role="gridcell"`, `aria-selected`. **Δ** add `aria-colindex` to header cells and body cells so pinning/virtualization don't corrupt AT column counting.

**Keyboard map:**

| Key | Action |
|---|---|
| `Tab` | Toolbar (search → filter chips → density → View) → grid (single stop, then roving tabindex) → pagination. |
| `↑ / ↓` | Move row focus; `scroll-mt` keeps the focused row clear of the sticky header. |
| `Enter` | Open focused row (if `onRowClick`); on header sort button, toggle sort. |
| `Space` | Toggle row selection; on drag handle, pick up / drop (dnd-kit). |
| `Shift+Enter` / `Shift+Click` | Add column to multi-sort. |
| `Shift+↑/↓` | Range-extend selection. |
| `Cmd/Ctrl+A` | Select all (already implemented). |
| Resize separator: `←/→`, `Shift+←/→`, `Home` | ±16 / ±48 / reset width. |
| Header menu: `Move left/right` | Keyboard-safe reorder. |
| `Esc` | Close popover/menu/sheet (Radix default). |

**Other requirements:**
- **focus-visible** on every interactive element via the `ring` token (`focus-visible:ring-2 ring-ring`); never strip an outline without a token replacement.
- **aria-live:** one visually-hidden `role="status" aria-live="polite"` region announces sort, filter ("Filtered: 3 filters, 24 results"), page ("Page 3 of 20, showing 51–75 of 480"), density, and layout reset (debounced). Hard errors use `role="alert"` / `aria-live="assertive"`.
- **Touch targets ≥44px** on coarse pointers (rows, pager buttons, resize/drag handles); WCAG 2.5.8 hard floor 24px honored for all pointers.
- **2.5.7 drag alternatives:** resize = keyboard separator; reorder = header "Move left/right" menu (both specced in §C).
- **2.4.11 focus not obscured:** `scroll-mt-[<headerHeight>]` on focusable rows/cells so the sticky header never hides a focus ring; header `z-20` above rows.
- **1.4.10 reflow:** the data body may scroll horizontally (data-table exception); the **chrome** (toolbar + pager) reflows to the one-line-with-drops behavior in §B at 320px / 400% zoom.
- **Contrast & non-color:** sort/filter/pin state always pairs an **icon or text** with color; pinned divider uses `--border`; verified ≥4.5:1 (text) / ≥3:1 (UI) in **both** themes. Respect `prefers-reduced-motion` on row hover, skeleton pulse, and dnd transitions.

---

## I. Personalization scope statement

| Concern | Where it lives | Mechanism |
|---|---|---|
| Column **order**, **sizing**, **visibility**, **pinning**, **density** | **Persisted per user, per grid** (server-side) | `GridLayoutPersistenceAdapter` (`namespace: 'ui.data-grid'`, `key: <grid id>`), debounced ~600ms, best-effort (`use-grid-layout.ts`) |
| Global **search**, per-column **filters**, **sort**, **page**, **limit** | **URL** searchParams | nuqs (`13-nextjs-apps.mdc` — "Shareable filter state → URL via nuqs"); serialized via `toPaginatedQuery` |
| Row **selection** | Ephemeral client state | neither persisted nor URL |

**Why this split is the correct UX:** layout is about *who is looking* (ergonomics/identity) — it should follow me across sessions and devices and must **not** leak into a link I share or reset when I clear a filter. Query is about *what data is shown* (task/context) — it must be **bookmarkable, deep-linkable, and reproducible** so a colleague opening my link sees the same rows ("ERRORED consultations, sorted by time, page 3") without inheriting my column widths. Density is borderline but is an ergonomic preference → personalization. This is exactly why there are **two reset affordances**: **"Clear filters"** (query/URL) and **"Reset layout"** (personalization) — never merged.

---

## Consolidated deltas vs current code (for the implementation plan)

| Δ | Area | Change |
|---|---|---|
| Δ1 | Layout | Fill-height mode (`flex-1 min-h-0`, scroll container `h-full`); inset becomes the scroll boundary. |
| Δ2 | Responsive | `@container` on grid root; `Filters` `Button` → `Popover`(md) / `Sheet`(sm) collapse; pager end-dropping window. |
| Δ3 | Resize | Render the missing resize separator with hover/active affordance, double-click reset, and keyboard resize. |
| Δ4 | Reorder | Add header-menu "Move left/right" as the 2.5.7 alternative. |
| Δ5 | Pinning | Pass `withBorder: true` (scroll-aware divider shadow); pinned cells `bg-inherit`. |
| Δ6 | Filters | Add boolean control; add header-menu "Filter…"; rename "Reset" → "Clear filters"; trim operator sets. |
| Δ7 | Pagination | Item-range status (move selection count to action bar); numbered current±2 window with ellipsis/first/last; standardize page sizes `[25,50,100]`. |
| Δ8 | Personalization | Gate first paint on `isLayoutReady` / SSR-inject layout; add "Reset layout". |
| Δ9 | A11y | `aria-colindex`; live-region announcements; coarse-pointer 44px + comfortable-density enforcement; `scroll-mt` focus guard. |

This spec is ready to embed in the implementation plan; every visible value resolves to a `globals.css` semantic token, every control names an existing shadcn primitive, and each requirement (three regions, per-user column personalization, per-type filter+sort, responsive one-line pagination) is honored with a single decision rather than an option list.
