# TASK-423 — Figma Frame Spec & Authored Inventory (Phase 1, Figma-first gate)

- **Date**: 2026-07-05
- **File**: `HOPE-Admin-Console` (figma-bridge fileKey `unsaved-mr6isxam-irt8mt29`, page `0:1`)
- **Authoring method**: written **directly into Figma** through the `figma-bridge` MCP (write-capable: create frame/text/shape/image, auto-layout, fills/strokes/effects, text patch, duplicate/reparent/group, delete-with-confirm, screenshot export). This document is the frame/node inventory + Dev-Mode annotation record for the approval gate — it is **not** a to-be-authored spec; everything below already exists in the file.
- **Evidence**: `figma-evidence/` in this ticket folder — `before-*` and `after-*` PNG exports of every touched frame.

## Bridge capability notes (for the record)

- Supported and used: `create_frame`, `create_text`, `create_shape`, `set_auto_layout`, `set_node_properties`, `set_solid_fill`, `set_stroke_properties`, `set_effects`, `set_text_content`, `set_text_properties`, `delete_nodes(confirm)`, `save_screenshots`, `get_document/get_node/get_metadata/get_variable_defs`.
- Not supported by the bridge (limitations to note for the design owner):
  - **No published components / variants / component properties** — new pattern mocks are plain frames with named layers (machine-readable, per rule 12), not component instances. The existing file has the same precedent (frames 06–09 are drawn mocks, not published components).
  - **No Figma variables** — `get_variable_defs` returned an empty collection; the file has no token variables. All colors are raw hex values that resolve 1:1 to `packages/ui/src/styles/globals.css` tokens (mapping below), same as every pre-existing frame.
  - **No native Dev-Mode annotation objects / sections** — annotations are authored as visible annotation text layers inside each card (consistent with the file's existing annotation style).
- Reliability: the plugin socket drops if calls are issued in parallel — all writes were done sequentially; the one mid-session disconnect self-recovered in ~60 s with no ghost nodes.

## Token mapping (every visible value → `globals.css`)

| Hex used | Token (light) | Where |
|---|---|---|
| `#fbfcfd` | `--background` | frame/card backgrounds, region bands |
| `#ffffff` | `--card` / `--slate-0` | cards, grid frame, inputs, buttons |
| `#f4f7f8` | `--muted` (slate-50 tint used by existing frames) | header rows |
| `#f7f9fa` | `--sidebar` | (pre-existing) |
| `#e2e8ec` | `--border` (`--slate-200`) | borders, dividers, skeleton bars |
| `#cfd8de` | `--slate-300` | dashed region boundaries, scrollbar hints, grab handle |
| `#e6f3f5` | `--accent` | selected row, active chip, hovered menu item |
| `#0e626e` | `--accent-foreground` (`--teal-700`) | text on accent |
| `#0f7a8b` | `--primary` (`--teal-600`) | region tags, current-page button, resize-active, badges, "Reset to default layout" |
| `#0e1a24` | `--foreground` (`--slate-950`) | titles |
| `#2b3942` | `--slate-800` | header cell text |
| `#44535e` | `--slate-700` | body text |
| `#5a6a77` | `--muted-foreground` (`--slate-600`) | annotations |
| `#7c8b95` | `--slate-500` | placeholders, faint labels |
| `#9f3a3a` | `--destructive-strong` (`--red-700`) | error-state panel text |
| Dark: `#0c1418` `--background` · `#111d23` `--card` · `#16242b` `--muted` · `#25333b` `--border/--input` · `#16323b` `--accent` · `#bbe7ec` `--accent-foreground` · `#e6edf0` `--foreground` · `#c7d2d8` sidebar-fg ramp · `#93a4ae` `--muted-foreground` · `#2fafc0` `--primary` (teal-400) · `#042a30` `--primary-foreground` | | dark reference card + 12 (Dark) |

Shadow effects: pinned divider `DROP_SHADOW #0e1a24 @ 8% (4,0,6)`; popover elevation `DROP_SHADOW #0e1a24 @ 10% (0,4,12)` — matches the 03-elevation scale.

## Frame inventory — what changed, frame by frame

### `08 - Layouts & Data Patterns` (`11:300`, Foundation section) — extended 1440×1120 → 1440×3250 (auto-layout hug)

| Node | Card | Content |
|---|---|---|
| `11:302` | subtitle | updated to introduce the standardized grid (TASK-423) |
| `11:303` | ~~Filter bar pattern~~ | **deleted** (superseded by the grid toolbar region) |
| `79:2789` | **Data grid — 3-region anatomy** | Region 1 toolbar (omni search `w-64`, dashed `+ Status` chip, active `Plan: Enterprise ×` accent chip, `Clear filters` ghost, density `[≡]` + `View ▾` buttons) · Region 2 grid frame (`81:2805`: sticky header row w/ select-all, drag glyphs, sort `↑¹`/`↓²` priorities, filtered `Status ●▾`, **active resize separator** (3px `--primary`), **pinned divider + scroll shadow** after Name, 48px rows, selected row `bg-accent` split around the divider to show `bg-inherit`, scrollbar hint) · Region 3 pagination (`Showing 1–25 of 480` · `Rows per page [25▾]` · `« ‹ 1 … 5 6 [7] 8 9 … 20 › »` with solid current-page Button) · 3-line annotation: fill-height flex chain, min column widths, resize keyboard map (2.5.7), aria-grid semantics, density tokens 48/36, tabular-nums zero-CLS |
| `81:2840` | **Data grid — per-type filter controls** | six panels: text (operator Select + debounced Input), number (Between two-inputs), date/datetime (Calendar single/range + relative presets), enum/select (Command single faceted), multi-select (Command multi + count Badge, `[in]:a|b`), boolean (3-state Any/Yes/No — Δ new) · footer: active indication (header glyph, chip ×, Filters badge), "Clear filters" vs "Reset layout" naming discipline, nuqs bracket-grammar serialization |
| `81:2855` | **Data grid — responsive collapse (container queries)** | 5-row matrix (≥xl / lg–xl / md–lg / sm–md / <sm) × (toolbar behavior, pager end-dropping behavior) exactly per spec §B1/§B2 · Filters **Popover mock** (md) and bottom **Sheet mock** (<md, with Columns + Density sections and grab handle) · cursor-pager variant + zero-layout-shift loading rules · WCAG 1.4.10 reflow note |
| `81:2886` | **Data grid — column interactions & personalization** | header DropdownMenu mock (Sort asc/desc/reset ─ Pin left/right/unpin ─ **Move left/right** (2.5.7) ─ **Filter…** ─ Hide column, hovered item) · View Popover mock (Command search, checklist, ≥1-visible rule, **"↺ Reset to default layout"** footer) · density + full keyboard map panel · personalization scope panel (server `ui.data-grid/<gridId>` vs URL vs ephemeral, two resets, `isLayoutReady` gating) · a11y footer (focus order, live region, contrast, reduced motion, 2.4.11) |
| `81:2902` | **Data grid — dark theme reference** | same anatomy token-swapped: toolbar, grid w/ selected row `#16323b`, pager with `#2fafc0`/`#042a30` current page · contrast verification note |
| `11:338` | Detail tabs pattern | renamed (was "Detail tabs & pagination"), old pagination mock nodes `11:344/345/346` + stale recipe `11:347` **deleted**; label + recipe text updated to point at the grid pattern |

### `08-tablet - Layouts & Data Patterns` (`81:2936`, new, 768×720)

md–lg rendition: search `flex-1 min-w-40`, `⚙ Filters` + count Badge `2`, icon-only density/View, grid with truncated columns + horizontal scrollbar + 44px row rhythm, pager `1–25 of 480 · [25▾] · ‹ 1 … 6 [7] 8 … 20 ›`, annotation line.

### `08-mobile - Layouts & Data Patterns` (`81:2954`, new, 390×720)

<sm rendition: full-width search, `⚙ Filters (3)` (Sheet), 3-column grid with h-scroll hint, pager `7 / 20` + icon-only `‹ ›` 44×44 Buttons, annotation (Sheet contents, aria-current, 1.4.10, 320px/400% reflow).

### `09 - Screen Templates` (`11:348`) — extended 1440×900 → 1440×1222 (auto-layout hug)

| Node | Change |
|---|---|
| `11:350` | subtitle: list template now uses the standardized grid; five grid states below |
| `11:353/357/359/361` | T1 zones updated: Grid toolbar (08), VirtualizedDataGrid 48px fill-height resize/reorder/pin/hide, one-line pagination `«‹ ±2 ›»` |
| `81:2920` | **new card "T1 states — standardized data grid (all five)"**: 1 · Default · 2 · Loading skeleton (initial disabled-chrome + refetch row-skeletons + skeleton bars) · 3 · Empty two variants (no data → CTA / no results → Clear filters) · 4 · Error two variants (alert block + Retry / stale rows + ErrorBanner) · 5 · Personalization-loading (`isLayoutReady` gate, SSR-inject zero flash) · footer: focus order + live-region announcements |

### `09-tablet - Screen Templates` (`81:2970`, new, 768×380) / `09-mobile - Screen Templates` (`81:2974`, new, 390×380)

Zone diagrams of the list template at md / <sm with collapse + state notes (states identical; chrome persists; inset is the scroll boundary).

### `12 - Tenants List` (`11:495`) and `12 - Tenants List (Dark)` (`11:1461`) — representative instance

| Node (light / dark) | Change |
|---|---|
| `11:567` / `11:1502` | toolbar → `⌕ Search tenants… · [+ Status] [+ Plan] · Clear filters · [≡] [⊞ View ▾]` (was Status/Plan/Sort selects + count) |
| `11:570` / `11:1505` | header → `☐ ⣿ Name ↑ · Key · Plan ▾ · Users · Status ●▾ · Storage · Updated · ⋯` (select-all, drag handles, sort arrow, filter glyph; ID → human-readable Key per real columns) |
| `11:571` / `11:1506` | rows → per-row `☐` + keys (`sunrise-medical`, …) matching the real tenants grid |
| `11:572` / `11:1507` | pagination → `Showing 1–24 of 24 · Rows per page [25▾] · ‹ [1] ›` (item-range status left, all-Button navigator right) |
| `11:565` / `11:1500` | count note → offset pagination endpoint + `grid id ui.data-grid/tenants` |
| `11:562` / `11:1497` | screen notes → standardized grid (08), per-user layout persistence, nuqs URL filters, sort Name asc, page sizes 25/50/100 |
| `11:549` / `11:1484` | state-variants label → cross-references the full five-state set in 09 |

## Rule-12 Definition-of-Ready checklist

- [x] States: default / loading-skeleton / empty (no-data vs no-results) / error / personalization-loading — 09 `81:2920` + 12 state strip
- [x] Light AND dark — 08 dark reference card `81:2902`; 12 light `11:495` + dark `11:1461`
- [x] Desktop 1440 (08, 09, 12) + tablet 768 + mobile 390 variants for the 08/09 responsive patterns (`81:2936`, `81:2954`, `81:2970`, `81:2974`) — naming grammar `NN-<device> - Name`
- [x] A11y annotations: focus order, 2.5.7 drag alternatives (keyboard resize separator + Move left/right), 44px touch targets, aria-live/aria-sort/aria-colindex, 2.4.11 scroll-mt, 1.4.10 reflow — authored as annotation layers in each card
- [x] Token discipline: every visible value resolves to a `globals.css` token (mapping table above); 8-pt spacing; no new one-off values
- [x] Frames stay inside the approved taxonomy (06–09 Foundation patterns; 12 instance) — no new numbers invented
- [ ] **Product-owner approval** (gate) — see below
- [ ] Mark approved frames **Ready for Dev** in Figma Dev Mode (manual step in the Figma UI; the bridge has no status API)

## Next action required from the product owner

Review and approve (or request changes on) exactly these frames, then the approval date + this inventory get recorded in the ticket `README.md` and Phase 3+ UI implementation may start:

1. `08 - Layouts & Data Patterns` — the four new grid cards + dark reference (`79:2789`, `81:2840`, `81:2855`, `81:2886`, `81:2902`)
2. `08-tablet` / `08-mobile` (`81:2936` / `81:2954`)
3. `09 - Screen Templates` — updated T1 + new five-states card (`81:2920`)
4. `09-tablet` / `09-mobile` (`81:2970` / `81:2974`)
5. `12 - Tenants List` + `12 - Tenants List (Dark)` (`11:495` / `11:1461`)

Screenshots for async review: `figma-evidence/after-*.png` (with `before-*.png` for diffing).
