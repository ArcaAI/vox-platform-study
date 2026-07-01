> _Relocated from `docs/implementation/TASK-372-Shared-Component-System/MANUAL-E2E-TESTS.md` (TASK-385 docs alignment)._

# TASK-372 — Shared Component System · Manual E2E / QA Checklist

> **Scope:** a **component-level** manual QA pass for the three flagship `@arcaai/ui` components — `VirtualizedDataGrid`, `HistoryTimelineList`, `LiveTranscript` — exercised through their **admin consuming surfaces**. Run this in addition to the automated suites (443 Vitest + the Playwright specs in [TRACEABILITY-MATRIX.md](../traceability/shared-components.md)); it covers the things automation can't assert well: **visual** light/dark fidelity, **density** feel, **motion**/reduced-motion, real **media**/lightbox/PDF/audio, and **keyboard a11y** by hand.

| | |
|---|---|
| **Ticket** | [TASK-372](../../implementation/TASK-372-Shared-Component-System/README.md) · companion to [DESIGN-SPEC.md](../../designs/admin/shared-components.md) |
| **App under test** | `@arcaai/admin` (`apps/admin`, dev `http://localhost:5174`) against a running API (`http://localhost:8868/api/v1`) |
| **Login** | `super_admin` seed (`tests/helpers` `SEEDED_USERS.superAdmin`) — lands on `/tenants` with no tenant scoping |
| **Last updated** | 2026-06-30 |

## How to use this checklist

1. Bring up the stack (API + admin dev server + DB seed). Do **not** assume it's running.
2. For each component, run the **Desktop → Tablet → Mobile** blocks, then the **Light/Dark + Density** and **Keyboard & a11y** blocks.
3. Tick `[x]` pass / `[ ]` fail; log a defect id next to any failure.
4. **Tiers** (TASK-384 / `use-breakpoint.ts`): **Mobile** `< 768`, **Tablet** `768–1023`, **Desktop** `≥ 1024`. Resize the window (or use device emulation) to cross each boundary.
5. **Themes:** toggle light/dark from the top bar. **Density:** toggle Comfortable/Compact from the grid toolbar (grid) — for timeline/transcript, density follows the app `DensityProvider`.
6. **Reduced motion:** enable OS "Reduce motion" (macOS: System Settings → Accessibility → Display) and re-check the rows marked **(RM)**.

### Environments matrix (run each component through all six)

| | Light | Dark |
|---|---|---|
| **Comfortable** | ☐ D ☐ T ☐ M | ☐ D ☐ T ☐ M |
| **Compact** | ☐ D ☐ T ☐ M | ☐ D ☐ T ☐ M |

---

## Pre-flight

- [ ] API health responds: `curl -s localhost:8868/api/v1/health` → `200`.
- [ ] Admin dev server is up (`http://localhost:5174`) and the login page renders (the `_smoke.spec.ts` baseline).
- [ ] Logged in as `super_admin`; landed on **`/tenants`**.
- [ ] Seed data present: ≥ a few tenants, ≥ a few users, ≥ one consultation with **history** items, ≥ one **audio** recording, and audit-log rows (for cursor paging).
- [ ] No console errors on first paint (open DevTools console; keep it open through the pass).

---

## Component 1 — `VirtualizedDataGrid`

**Where:** `/tenants` (client-mode grid — best for interaction), `/users` (server-mode: sort/filter/search/offset), `/audit-log` (cursor mode — D7). Foundation frames `02 · DataGrid 60:745`, `04 · Full-Screen Table 59:155`.

### Desktop (`≥ 1024`)

- [ ] Grid renders inside a `rounded-md border` card; **sticky header** stays on vertical scroll.
- [ ] Rows are **virtualized** — scrolling a large list (Users/Audit) stays smooth; DOM node count stays bounded (spot-check in Elements).
- [ ] **Global search** narrows rows live; clearing restores them.
- [ ] **Column sort** via header menu (or click): ascending → descending → none; the sort indicator + `aria-sort` update.
- [ ] **Faceted filter** (Status) opens a popover, multi-select narrows rows, a **Reset/Clear** affordance appears and clears.
- [ ] **View** (column visibility) hides/shows columns; hidden columns truly disappear and can be re-shown.
- [ ] **Column reorder** by dragging a header handle; order holds after release.
- [ ] **Column resize** by dragging the edge; width holds.
- [ ] **Column pinning** (if exposed) keeps the pinned column fixed during horizontal scroll.
- [ ] **Row selection** (checkbox) — single + select-all; a bulk **action bar** appears only when ≥ 1 row is selected.
- [ ] **Offset pagination** (Users): page size + next/prev change the page; total/row-count is correct.
- [ ] **Cursor pagination** (Audit, D7): next/prev walk **disjoint** pages; the terminal page disables "next"; no duplicate rows across pages.
- [ ] **Row click** opens the detail route (Tenants → `/tenants/:id`).

### Tablet (`768–1023`)

- [ ] App shell collapses to the **icon rail**; the grid still fills the content column.
- [ ] **Condensed column set** is shown (lower-priority columns hidden by the responsive wrapper) — no janky horizontal overflow.
- [ ] Hidden columns are still re-enableable via **View**.
- [ ] Toolbar wraps gracefully (search + facets + density + View) without clipping.
- [ ] Sort / filter / search / selection all still work.

### Mobile (`< 768`)

- [ ] The table is replaced by a **card-list** (`role="list"`), one card per row.
- [ ] A full-width **search** box sits atop the list and narrows cards (empty state on no match; recovers on clear).
- [ ] A **FAB** (≥ 56px) exposes the surface's primary create action ("New tenant"/"New user").
- [ ] Each card shows leading + title + subtitle + trailing **StatusBadge** + chevron; **tapping a card** opens the detail route.
- [ ] Server surfaces (Users) show a compact **Prev/Next** pager (≥ 44px); client surface (Tenants) filters locally.
- [ ] Every control is **≥ 44px**; no horizontal page scroll.

### States

- [ ] **Loading** → skeleton **rows** (desktop/tablet) / skeleton **cards** (mobile) matching the column/card shape — **not** a spinner (rule 10).
- [ ] **Empty** (search to no match) → `Inbox` icon + "No results" + description.
- [ ] **Error** (kill API, reload) → `TriangleAlert` + message + **Retry** that re-fetches on recovery.

### Light/Dark + Density

- [ ] **Light → Dark**: card/header/row/border/hover/selected all swap via tokens; **no** hardcoded colors, no contrast loss; StatusBadges remain legible.
- [ ] **Comfortable → Compact**: row height + padding visibly tighten; header + controls stay aligned; choice **persists** after reload (D8 `ui.data-grid`) and across surfaces.
- [ ] StatusBadge conveys state by **icon + label + color**, never color alone (verify in both themes).

### Keyboard & a11y (`role="grid"`)

- [ ] Tab order is logical: toolbar → header → body → pagination.
- [ ] Roving focus in the grid: **Arrow** keys move cell focus; **Home/End** jump; **Space/Enter** toggles selection; **Ctrl/Cmd+A** selects all.
- [ ] Header cell: **Enter** opens the sort/pin/hide menu; menu is arrow-navigable; **Esc** closes and restores focus.
- [ ] Faceted filter + View popovers are **focus-trapped**; **Esc** closes; focus returns to the trigger.
- [ ] Every interactive element shows a **2px visible focus ring**.
- [ ] Screen reader (VoiceOver): grid announces `role="grid"`, column headers, `aria-sort`, row/col counts, and selection labels.

---

## Component 2 — `HistoryTimelineList`

**Where:** `/history` (consultation history feed). Design-system component (no dedicated Figma frame yet — see DESIGN-SPEC §5).

### Desktop (`≥ 1024`)

- [ ] Feed renders newest-first (`role="feed"`), each item a collapsible card (timestamp + title + badges incl. **AI**/type/status).
- [ ] **Expand/collapse** an item toggles its body; the chevron + `aria-expanded` update.
- [ ] **Infinite scroll** loads older items at the bottom (skeleton while fetching); scroll position is preserved.
- [ ] **Markdown** item renders safely (no raw HTML injection); long markdown clamps to a preview and expands.
- [ ] **PDF** item: viewer mounts lazily on expand; pages render; controls work.
- [ ] **Image** item: grid renders; clicking opens a **lightbox** (full-res); arrows navigate; **Esc** closes; focus returns to the thumbnail.
- [ ] **Audio** item: player loads; play/pause works; (review) **word click → seek** moves playback.
- [ ] **File** item: download link works.

### Tablet (`768–1023`)

- [ ] Feed reflows; image grids drop to 2–3 columns (`@container`); badges may wrap to a second line.
- [ ] Lightbox + PDF controls are comfortably tappable.

### Mobile (`< 768`)

- [ ] Cards span full width with reduced padding; image grid → 1–2 columns.
- [ ] **Lightbox is full-screen**; full-res image lazy-loads; close + navigate are ≥ 44px.
- [ ] Media is **lazy** (images `loading="lazy"`; PDF mounts only on expand; audio loads metadata only) — verify in the Network panel.
- [ ] Expand affordance + media buttons are **≥ 44px**.

### States

- [ ] **Loading** → skeleton items (`role="status"` "Loading history"), not a spinner.
- [ ] **Empty** → "No history yet".
- [ ] **Error** (feed-level) → alert + Retry; **per-item media error** falls back inline (PDF → download, broken image → fallback, audio 404 → message) without crashing the feed.

### Light/Dark + Density + Motion

- [ ] Light/Dark swap clean; **AI** badge uses the `--ai` token; entity chips legible in both.
- [ ] Comfortable → Compact tightens item padding + header scale.
- [ ] **(RM)** Expand/collapse animates ~200ms normally; with **Reduce motion** it snaps instantly (no transition).

### Keyboard & a11y (`role="feed"`)

- [ ] Container exposes `role="feed"` + `aria-busy` while loading; each item is `aria-labelledby` its heading.
- [ ] The expand control is a real **button** with `aria-expanded` (not on the article); Tab reaches it; Enter/Space toggles.
- [ ] Lightbox is focus-trapped; PDF + audio controls are keyboard reachable and labelled.
- [ ] Focus ring visible on every interactive element.

---

## Component 3 — `LiveTranscript`

**Where:** `/live` (live consultation captioning, fed by `@arcaai/vox`). Design-system component (no dedicated Figma frame yet — see DESIGN-SPEC §5). Needs an active/replayable session to exercise fully.

### Desktop (`≥ 1024`)

- [ ] Panel renders (`role="log"`); segments show speaker (text + color) + timestamp + text.
- [ ] **Interim vs final**: interim text is visually distinct (italic/muted); the committed prefix (`stableChars`) doesn't flicker as it settles.
- [ ] **Autoscroll** stays pinned to the newest segment while at the bottom.
- [ ] Scrolling **up pauses** autoscroll; a **Jump to live** control appears and re-pins on click (and signals new content).
- [ ] Scrolling up loads **older history**; scroll position is preserved on prepend.
- [ ] **Inline edit** (D4): pencil opens the Lexical editor on a final segment; **⌘/Ctrl+Enter** saves (optimistic), **Esc** cancels; a failed save reverts + toasts.
- [ ] **Word click → seek** (D9): clicking a word seeks the audio; the active word highlights (`aria-current`).
- [ ] **Listening pulse** animates while capturing.

### Tablet (`768–1023`)

- [ ] Panel fills the content column; long segments wrap; speaker badge stays inline.
- [ ] The editor expands to fill the row; word tokens are tappable.

### Mobile (`< 768`)

- [ ] Full-height, full-width transcript; compact line spacing; speaker label stacks above text when tight.
- [ ] **Jump to live** is a ≥ 44px pill; scroll-up loads older history.
- [ ] Tap a final segment → editor fills the viewport width; **Save/Cancel** ≥ 44px.
- [ ] Word tap → seek works in **review**; (live capture has no seekable file — documented, not a bug).

### States

- [ ] **Loading** → skeleton lines, not a spinner.
- [ ] **Empty** → "No transcript yet. Start recording…".
- [ ] **Network drop** → inline reconnection banner; the existing transcript is **retained** (not cleared).

### Light/Dark + Density + Motion

- [ ] Light/Dark swap clean; speaker color roles map to tokens (`--ai/--success/--warning/--primary/--info`).
- [ ] Comfortable → Compact tightens line spacing + segment padding.
- [ ] **(RM)** The breathing **pulse** degrades to a **static dot** and autoscroll becomes **instant** under Reduce motion.

### Keyboard & a11y (`role="log"`)

- [ ] Container is `role="log"` `aria-live="polite"` `aria-relevant="additions"` — new **final** segments are announced.
- [ ] **Interim** text is `aria-live="off"` (no announcement spam).
- [ ] While **editing**, the live region is set `aria-live="off"` (no churn); restored after save/cancel.
- [ ] The editor is `role="textbox"` `aria-multiline`, labelled; interactive words are real **buttons** ("Jump to mm:ss — '<word>'"); with no audio controller, words are non-interactive `<span>`s (no fake buttons).
- [ ] Focus ring visible; Tab order sensible (jump-to-live, words, edit).

---

## Cross-component regression (quick pass)

- [ ] No layout shift / overflow at the **exact** breakpoints (767↔768, 1023↔1024).
- [ ] No `console` errors/warnings across all three surfaces.
- [ ] Tokens only — spot-check Elements for any stray hex/`rgb()` inline styles (should be none).
- [ ] All three survive a **theme** toggle and a **density** toggle without remount glitches.
- [ ] Reduce-motion respected by **all** animated affordances (grid hover, timeline expand, transcript pulse/autoscroll).

## Sign-off

| Component | Desktop | Tablet | Mobile | Light/Dark | Density | a11y | Tester / date |
|---|---|---|---|---|---|---|---|
| VirtualizedDataGrid | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| HistoryTimelineList | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| LiveTranscript | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |

> **Note:** the timeline + live-transcript have **no admin _grid_ E2E** (they bind to the clinical `/history` and `/live` surfaces, not a data grid) — this manual pass + their Vitest suites are their primary D/T/M coverage.
