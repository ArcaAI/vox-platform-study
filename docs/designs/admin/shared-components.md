> _Relocated from `docs/implementation/TASK-372-Shared-Component-System/DESIGN-SPEC.md` (TASK-385 docs alignment)._

# TASK-372 — Shared Component System · Design Spec (Desktop / Tablet / Mobile)

| | |
|---|---|
| **Ticket** | [TASK-372 — HOPE Shared Component System](../../implementation/TASK-372-Shared-Component-System/README.md) |
| **Scope** | **Component-level** design spec (a design *system*, not a single screen) for the three flagship `@arcaai/ui` components: `VirtualizedDataGrid`, `HistoryTimelineList`, `LiveTranscript` |
| **Status** | Authored 2026-06-30 (components already shipped & verified — [README §4](../../implementation/TASK-372-Shared-Component-System/README.md#4-implementation-summary)) |
| **Conventions** | [`docs/qa/E2E-AND-QA-CONVENTIONS.md`](../../qa/E2E-AND-QA-CONVENTIONS.md) §2 |

> **What this is.** A token-driven, responsive (Desktop / Tablet / Mobile),
> light/dark, two-density (Comfortable/Compact), WCAG 2.2 AA spec for the three
> components **as a design system**. Each is a composable primitive reused across
> many surfaces, so this spec describes *component* behavior, not one page. The
> grid underpins the admin list surfaces (TASK-371 **F1/U1/AU1**); the timeline +
> transcript are **clinical** components (consultation history / live captioning,
> [README §1.2](../../implementation/TASK-372-Shared-Component-System/README.md#12-business-context)) consumed via `@arcaai/vox`.

## Grounding (read before editing)

- **Figma frames (documented node ids only — the live Figma bridge has _no file connected_ this session; do _not_ attempt live reads/writes):**
  - `VirtualizedDataGrid` → foundation **`02 · DataGrid 60:745`** + **`04 · Full-Screen Table 59:155`** (cited in [README §3.4](../../implementation/TASK-372-Shared-Component-System/README.md#34-component-1--virtualizeddatagrid) and the TASK-371 matrix rows F1/U1/AU1).
  - `HistoryTimelineList` + `LiveTranscript` → **no dedicated frame yet**; grounded in the shipped public APIs (`packages/ui/src/components/{timeline,live-transcript}/types.ts`) + the clinical consultation context ([README §1.2 / §2.5](../../implementation/TASK-372-Shared-Component-System/README.md#25-real-data-contracts-the-interfaces-to-reuse)). Dedicated D/T/M frames are deferred to **§5 — Figma frames to create later**.
- **Responsive model** ([TASK-384](../../implementation/TASK-384-Responsive-Admin-Surfaces/README.md); `apps/admin/src/hooks/use-breakpoint.ts`): **mobile `< md 768`**, **tablet `md..lg 768–1023`**, **desktop `≥ lg 1024`**.
- **Tokens** — semantic only, no hex: [`../TASK-371-Admin-Console-Redesign/theme.css`](../../implementation/TASK-371-Admin-Console-Redesign/theme.css) (`--background/--card/--muted/--border/--ring/--primary` + HOPE roles `--ai/--hope/--success/--warning/--info` + `--sidebar-*`; `--radius 0.625rem`; Inter / JetBrains Mono). Dark mode = the `.dark` variable swap (automatic).
- **Design rules** — [`11-ux-ui-principles.mdc`](../../../.cursor/rules/11-ux-ui-principles.mdc) (space/density/feedback/data-display/a11y), [`10-skeleton-loading.mdc`](../../../.cursor/rules/10-skeleton-loading.mdc) (skeletons-not-spinners), [`07-react-ui.mdc`](../../../.cursor/rules/07-react-ui.mdc) (cva + `data-slot` + `cn()`), [`12-design-workflow.mdc`](../../../.cursor/rules/12-design-workflow.mdc) (foundations tier 00–09).
- **Cross-cutting laws:** status is **never color-only** (icon + label + color); every motion respects `prefers-reduced-motion`; touch targets **≥ 44px** (Comfortable) and **≥ 32px** (Compact, rule 11 §7); 2px visible `ring-ring` focus.

---

## 1. `VirtualizedDataGrid` — `02 · DataGrid 60:745` + `04 · Full-Screen Table 59:155`

A massive, configurable, virtualized datagrid for admin lists (Tenants / Users / Audit). Source: `packages/ui/src/components/data-grid/*`. Responsive wrapper (app-level, keeps `@arcaai/ui` untouched): `apps/admin/src/features/data-grid/responsive-data-grid.tsx`.

### 1.1 Anatomy & tokens

| Part | Source | Token-driven styling |
|---|---|---|
| Toolbar | `data-grid-toolbar.tsx` | global search `Input`, faceted-filter chips (dashed `border-border`), **density toggle**, **View** (column visibility); `bg-transparent`, `text-muted-foreground` icons |
| Grid shell | `virtualized-data-grid.tsx` | `role="grid"` in a `rounded-md border` card; sticky header `bg-card`; rows `border-b`, hover `bg-muted/50`, selected `bg-accent` |
| Column header | `data-grid-column-header.tsx` | sort/pin/hide menu; `aria-sort`; drag handle (`bg`-less ghost) |
| Pagination | `data-grid-pagination.tsx` | offset (primary) + inert cursor (prev/next) — D7 |
| Skeleton | `data-grid-skeleton.tsx` | `<Skeleton/>` rows matching column count (rule 10) |
| Density | `lib/shared/surface.ts` `DENSITY_ROW_HEIGHT` | `comfortable` taller rows / `compact` denser; wrapper exposes `data-density` |

### 1.2 Desktop (`≥ 1024`)

- **Layout & grid** — full virtualized table fills the content column (`height` prop, default 480; admin uses 560). Sticky header; horizontal scroll with **pinned first column** when columns exceed the viewport. Column **reorder** (dnd-kit drag handle, keyboard sensor), **resize**, **visibility**, **pinning**.
- **Navigation** — keyboard grid model: arrows / Home / End, `Space`/`Enter` selection, `Ctrl/Cmd+A` select-all; header `Enter` opens the sort/pin/hide menu. Row click → row action (admin: open detail).
- **Primary actions** — toolbar right cluster: density toggle, **View** column menu; selection surfaces an `actionBar` (bulk actions) only when `selection > 0`. Page-level "New …" button lives above the grid (surface-owned).
- **Data display** — **table** (all columns). Status cells render `StatusBadge` (icon + label + color). Mono `font-mono` for ids/keys.
- **Dialogs** — none owned by the grid; faceted filter + View are **popovers** (`align="end"`/`"start"`), focus-trapped, ESC closes.
- **Empty / loading / error** — loading → `DataGridSkeleton`; empty → `Inbox` icon + "No results" + description; error → `TriangleAlert` + message + **Retry**.
- **Touch targets** — ≥ 32px controls (desktop pointer-first); 2px focus ring throughout.

### 1.3 Tablet (`768–1023`)

- **Layout & grid** — same grid, **condensed column set**: the wrapper hides lower-priority columns via `condensedColumnIds` (e.g. Tenants keeps `name · key · resourceStatus`), so the table fits without horizontal thrash. Reorder/resize still available.
- **Navigation** — app shell collapses to an **icon-rail**; the grid keyboard model is unchanged.
- **Primary actions** — toolbar wraps to two rows if needed (`flex-wrap`); density + View remain in the right cluster.
- **Data display** — **table (condensed)**. Hidden columns remain re-enableable through **View** (nothing is lost, just de-prioritized).
- **Empty/loading/error** — identical to desktop.
- **Touch targets** — controls grow toward 44px (touch); facet/View popovers widen for finger taps.

### 1.4 Mobile (`< 768`)

- **Layout & grid** — the virtualized table **cannot** be CSS-toggled into cards, so the wrapper swaps to a **tap-through card-list** (`MobileCardList`, `role="list"`). One card per row: avatar / leading, title, subtitle, trailing `StatusBadge`, chevron when tappable.
- **Navigation** — app shell becomes a **drawer**; the card body is a full-width `≥56px` button (navigates to detail).
- **Primary actions** — a **FAB** (floating `≥56px` button) for the surface's primary create action; per-row actions move to the trailing slot.
- **Data display** — **card-list** (not a table). Server-paginated surfaces (Users) get a compact pager (`Prev`/`Next`, `≥44px`); client surfaces (Tenants) filter locally.
- **Search** — a full-width `≥44px` search box atop the list (server search when the surface drives `queryState`, else a client `mobileFilter`).
- **Empty/loading/error** — skeleton **cards** (rule 10); empty → bordered `Inbox` card; error → bordered `alert` card + `≥44px` Retry.
- **Touch targets** — every control ≥ 44px (search, pager, FAB, card body).

### 1.5 Density, light/dark, motion

- **Density** — `comfortable` (default) vs `compact` cuts row padding (`py-2`→`py-1`) and row height; the toggle persists per-user via `useUserSettings` (`ui.data-grid`, **D8**).
- **Light/dark** — all surfaces via tokens; dark = `.dark` swap (e.g. `--card #111d23`, `--primary --teal-400`). No hardcoded colors.
- **Motion** — hover/selection transitions 150ms ease-out; reduced-motion removes row transitions.

### 1.6 Accessibility (`role="grid"`)

`role="grid"` + `rowgroup`/`row`/`columnheader`/`gridcell`; `aria-sort` reflects the active sort; `aria-rowcount` = the **true** total (virtualization-aware) and `aria-rowindex` per row; `aria-colcount`; selection checkboxes labelled ("Select all rows" / "Select row"); column menu trigger labelled "`<col>` column options"; reorder handle labelled "Reorder `<col>` column"; density + View controls labelled with `aria-pressed`/`role="combobox"`. Verified by the `@arcaai/ui` Vitest a11y assertions (`data-grid/__tests__/data-grid.vitest.tsx`).

---

## 2. `HistoryTimelineList` — design-system component (foundations 00–09; clinical context)

Reverse-chronological, expandable, **content-type-aware**, virtualized history of consultation **context items** (`packages/ui/src/components/timeline/*`). Row model `TimelineItemModel`; consumers adapt `ContextItem` → model via `mapItem` (admin: `apps/admin/.../history`). Renderer registry: markdown · pdf (lazy `react-pdf`) · image-grid+lightbox · audio (+word-seek) · file · mixed · custom · fallback.

### 2.1 Desktop (`≥ 1024`)

- **Layout & grid** — single virtualized column (`role="feed"`, `height` default 560). Each item is a `Collapsible` card: header (timestamp via `date-fns`, title, `TimelineBadge`s incl. `AI`/type/status) + lazily-rendered body.
- **Navigation** — newest-first (`order='desc'`); expand/collapse per item; infinite scroll loads older via `collection.fetchNextPage()` (bottom skeleton while fetching).
- **Primary actions** — expand/collapse; media open (image → lightbox, PDF → inline viewer, file → download, audio → player). Editing is **not** in the timeline (happens in the consultation editor).
- **Data display** — per-variant renderers; markdown is **XSS-safe** (no `rehype-raw`); long markdown clamps to a preview (~200 chars) and expands.
- **Dialogs** — image **lightbox** = focus-trapped `Dialog`, ESC closes, arrows navigate, focus restored to the triggering thumbnail; full-res `zoomSrc` swapped in on open.
- **Empty/loading/error** — loading → skeleton items (`role="status"` "Loading history"); empty → "No history yet"; error → `alert` + Retry; per-item media error → inline fallback (PDF→download, image `onError`, audio 404 message).
- **Touch targets** — expand affordance + media controls ≥ 32px (pointer); focus ring throughout.

### 2.2 Tablet (`768–1023`)

- **Layout & grid** — same feed; image grids reflow via `@container` (fewer columns). Item header may wrap badges to a second line.
- **Navigation/actions** — identical; lightbox + PDF controls grow for touch.
- **Data display** — image grid 2–3 cols; audio player full-width.
- **Touch targets** — controls toward 44px.

### 2.3 Mobile (`< 768`)

- **Layout & grid** — full-width feed; cards span the viewport with reduced padding (Compact-friendly). Image grid → 1–2 cols; **lightbox is full-screen** (full-res `zoomSrc`, lazy-loaded).
- **Navigation** — tap to expand; lazy media (`loading="lazy"` images; PDF mounts only on expand; audio loads metadata only).
- **Primary actions** — media open targets ≥ 44px; download is a `≥44px` link-button.
- **Data display** — single-column; markdown wraps; entity chips wrap.
- **Empty/loading/error** — skeleton cards; same empty/error semantics, full-width.
- **Touch targets** — ≥ 44px (expand row, media buttons, lightbox controls).

### 2.4 Density, light/dark, motion, a11y (`role="feed"`)

- **Density** adjusts item padding + header scale. **Light/dark** via tokens; `AI` badge uses `--ai`. **Motion**: expand/collapse 200ms ease-out, disabled under reduced-motion.
- **A11y** — container `role="feed"` + `aria-busy` while loading; each item `aria-labelledby` its heading; the expand control is a real `<button aria-expanded>` (valid ARIA — not on the article); lightbox/PDF/audio controls keyboard reachable + labelled. Verified by `timeline/__tests__/timeline.vitest.tsx`.

---

## 3. `LiveTranscript` — design-system component (`role="log"`)

Realtime, editable, infinite-scroll captioning for a live consultation (`packages/ui/src/components/live-transcript/*`). Fed by `@arcaai/vox` (`audio.transcriptSegments` + `currentTranscript`) or the rich `SttV2WebSocketClient.onTranscript` (word timings, **D9**). Inline editing via lazy **Lexical** (**D4**); word-level **click-to-seek** (**D9**); autoscroll + jump-to-live; ambient listening pulse.

### 3.1 Desktop (`≥ 1024`)

- **Layout & grid** — full-height virtualized scroll panel (`role="log"`, `height` default 480). Each segment row: speaker label (text + color role, never color-only), timestamp, text (final) or interim (italic/muted; `stableChars` settles the committed prefix), optional per-word tokens.
- **Navigation** — **autoscroll** pinned to bottom while at bottom; **pauses on scroll-up**; a floating **Jump to live** button re-pins (and signals new content). Older history loads on scroll-up via `collection.fetchNextPage()` (scroll position preserved on prepend).
- **Primary actions** — **edit** a final segment (pencil → lazy Lexical `textbox`; ⌘/Ctrl+Enter saves, Esc cancels; optimistic update + revert-on-error toast); **word click → seek** (`audioController.seek(word.start)`) during review/playback; **listening pulse** when capturing.
- **Data display** — final vs interim distinguished by style **and** the live region policy (below); gloss (`resultType:'gloss'`) links to its final by `utteranceIndex` (no duplicate row); confidence shown as text/badge, never color-only.
- **Empty/loading/error** — loading → skeleton lines; empty → "No transcript yet. Start recording…"; network drop → inline banner, existing transcript retained.
- **Touch targets** — edit / word / jump-to-live ≥ 32px (pointer); focus ring throughout.

### 3.2 Tablet (`768–1023`)

- **Layout & grid** — same panel, full width of the content column; segment rows wrap long text; speaker badge stays inline.
- **Navigation/actions** — autoscroll/jump-to-live identical; the Lexical editor expands to fill the row (rule 11 §1 flex-fill); word tokens grow for touch.
- **Touch targets** — controls toward 44px.

### 3.3 Mobile (`< 768`)

- **Layout & grid** — full-height, full-width transcript; segment rows single-column with compact line spacing; speaker label above text when space is tight.
- **Navigation** — autoscroll + a `≥44px` **Jump to live** pill; scroll-up loads older history.
- **Primary actions** — tap a final segment to edit (Lexical fills the viewport-width row, `≥44px` Save/Cancel); word tap → seek (review only — live capture has no seekable file, documented); pulse remains.
- **Data display** — interim row not announced (live-region off); confidence/speaker as compact text/badge.
- **Empty/loading/error** — skeleton lines; same empty/error; reconnection banner full-width.
- **Touch targets** — ≥ 44px (edit, word tokens where interactive, Save/Cancel, jump-to-live).

### 3.4 Density, light/dark, motion, a11y (`role="log"`)

- **Density** adjusts line spacing/segment padding. **Light/dark** via tokens; speaker color roles map to `--ai/--success/--warning/--primary/--info`. **Motion**: the **breathing pulse** uses the TASK-371 ambient pulse; under reduced-motion it degrades to a **static dot** and autoscroll becomes instant.
- **A11y** — container `role="log"` `aria-live="polite"` `aria-relevant="additions"` (announces new finals); the **interim** row is `aria-live="off"` (no spam); the live region is set `aria-live="off"` **while editing** (no churn); the Lexical editor is `role="textbox"` `aria-multiline` + labelled; interactive words are real `<button>`s ("Jump to mm:ss — '<word>'"), active word `aria-current`; with no `audioController`, words render as non-interactive `<span>`s (no fake buttons). Verified by `live-transcript/__tests__/live-transcript.vitest.tsx`.

---

## 4. Cross-cutting design system (applies to all three)

| Concern | Rule |
|---|---|
| **Tokens** | Semantic only (`bg-card`, `text-muted-foreground`, `border-border`, `ring-ring`, `bg-primary`, `bg-ai`, `text-hope`, `bg-success`, `bg-warning`). No hex. `--radius 0.625rem`. |
| **Light/dark** | Automatic via the `.dark` variable swap in `theme.css`; both themes must be checked. |
| **Density** | Two densities everywhere via a `DensityProvider` context (`comfortable` default). |
| **Status never color-only** | Every status = icon + label + color (`StatusBadge`, `components/shared/status-badge.tsx`). |
| **Motion** | 150 / 200 / 250 ms ease-out; ambient breathing pulse reserved for live states; **all** gated behind `prefers-reduced-motion`. |
| **Focus** | 2px visible `ring-ring` on every interactive element; logical tab order; ESC closes overlays; focus restored on close. |
| **Touch** | ≥ 44px (Comfortable / mobile) and ≥ 32px (Compact, rule 11 §7). |
| **Loading** | `<Skeleton/>` matching the loaded shape — never spinners/text (rule 10). |
| **Icons** | Lucide **or** Tabler allowed (D2); one set per component/surface. |

---

## 5. Figma frames

**Figma frames (created 2026-06-30).** Connected file **HOPE-Admin-Console** (`fileKey unsaved-mr0qkre2-nzazl7ou`). Structural/representative Tablet + Mobile frames grounded in the desktop `02 · DataGrid 60:745`, placed in a dedicated responsive band on the same page (not pixel-adjacent to each desktop frame, to avoid overlapping dense existing content):

| Frame name | Platform | Node ID |
|---|---|---|
| `TASK-372 · 02 DataGrid — Tablet` | Tablet (834) | `193:2` |
| `TASK-372 · 02 DataGrid — Mobile` | Mobile (390) | `194:35` |

`HistoryTimelineList` and `LiveTranscript` were **not** created: there is no existing Desktop frame to ground them in (they remain deferred below — do not fabricate node ids).

### Still deferred

Deferred to a serialized Figma pass once a file is connected (screenshots / visual alignment come later). These do **not** exist as frames today:

1. **`02 · DataGrid` — Tablet & Mobile variants** — condensed-column table (tablet) and the **card-list + FAB + mobile search/pager** (mobile). Today only the desktop `02 · DataGrid 60:745` / `04 · Full-Screen Table 59:155` frames exist; the responsive behavior is code-only (`responsive-data-grid.tsx`).
2. **`0x · HistoryTimelineList` (Desktop / Tablet / Mobile)** — a new foundations frame for the content-type-aware feed: item card anatomy, the renderer gallery (markdown / pdf / image-grid+lightbox / audio+word-seek / file / mixed), expand/collapse, and the full-screen mobile lightbox.
3. **`0x · LiveTranscript` (Desktop / Tablet / Mobile)** — a new foundations frame: segment row anatomy (final vs interim, `stableChars`, speaker, timestamp, word tokens), the **Lexical** inline-edit state, **Jump to live**, and the **listening pulse** (+ its reduced-motion static fallback).
4. **Shared states sheet** — skeleton / empty / error / reduced-motion variants for all three, in light + dark + Comfortable + Compact, so the foundations tier (00–09) carries one canonical state language.

> Numbering for items 2–3 is intentionally left as `0x` (foundations tier) — assign the concrete node ids when the Figma file is connected; do not fabricate ids here.
