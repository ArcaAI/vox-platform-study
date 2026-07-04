# TASK-378 — Collection Foundations (Card-Grid · Item-List · Scroll-Spy Timeline)

| | |
|---|---|
| **Ticket** | TASK-378 |
| **Type** | feature (`@arcaai/ui` foundation components) |
| **Created** | 2026-06-29 |
| **Updated** | 2026-06-30 |
| **Status** | Completed |
| **Scope** | `packages/ui` (`@arcaai/ui`) only — no `apps/admin`, no other packages |
| **Spec** | [`PHASE-2-PLAN.md` §4a](../TASK-371-Admin-Console-Redesign/PHASE-2-PLAN.md) (authoritative) |
| **Parent** | TASK-371 Admin Console Redesign (Phase 2, workstream #4a) |

---

## 1. Requirement Analysis

### Description

Add three reusable, semantic-token-driven **foundation** components to `@arcaai/ui`, built
TDD-first and barrel-exported. These are the `08 · Card-Grid` and `09 · Lists (Item-List &
Timeline)` foundation interfaces from the Admin Console redesign. Per
`.cursor/rules/12-design-workflow.mdc`, foundations are **references** that every product
tier (TASK-377 metrics, TASK-379 tenant blades) composes from.

1. **CardGrid + EntityCard** — responsive auto-fill collection of cards with selection,
   density, and async states.
2. **ItemList** — full-width expandable rows (disclosure → detail panel), density,
   roving-tabindex keyboard model, optional virtualization.
3. **ScrollSpyTimeline + useScrollSpy** — changelog-style vertical timeline with a sticky
   scroll-spy marker rail, reusing the existing timeline renderer registry.

Plus an extracted shared **useExpansion** hook (`lib/shared/use-expansion.ts`) refactored
out of `timeline/use-timeline.ts` and reused by both `ItemList` and the existing
`HistoryTimelineList` (via `useTimeline`).

### Business context

Foundation layer for the Phase-2 admin console. TASK-378 **blocks** `RunningTasksList`/
`ModelsList` (TASK-377) and the Departments / agent-instruction / storage lists (TASK-379).

### Acceptance criteria

- All three components implemented exactly to PHASE-2-PLAN §4a (props, cva variants,
  semantic tokens, loading/empty/error via `AsyncStateProps`, density via `data-density`).
- `useExpansion` extracted to `lib/shared`; `useTimeline` consumes it with **no public API
  change** and the pre-existing timeline tests stay green.
- Vitest coverage for every bullet in §4a.1(d), §4a.2(d) (incl. `use-expansion`), §4a.3(d)
  (incl. `use-scroll-spy`), with `vitest-axe` checks where the plan says "axe pass" and a
  mocked `IntersectionObserver` for scroll-spy.
- New collection sub-barrel + root-barrel exports (mirroring the TASK-372 canonical style),
  no name collisions.
- `pnpm --filter @arcaai/ui test` / `build` / `lint` all pass; no regressions.

### Standards honored

`07-react-ui.mdc` (cva + `data-slot` + `cn()`, never fork primitives), `11-ux-ui-principles.mdc`
(WCAG 2.2 AA, ≥44px targets, visible focus, status = dot+label never color-only,
`prefers-reduced-motion`, two densities), `10-skeleton-loading.mdc` (Skeleton not spinners),
`12-design-workflow.mdc` (semantic tokens only).

---

## 2. Current State Evaluation

### Reused (not rebuilt)

| Asset | Path | Use |
|---|---|---|
| Surface contracts | `lib/shared/surface.ts` | `Density`, `DENSITY_ROW_HEIGHT {comfortable:48,compact:36}`, `DENSITY_PADDING_Y`, `AsyncStateProps`, `BaseSurfaceProps` |
| Expansion controller | `components/timeline/use-timeline.ts` | controlled/uncontrolled + `single`/`multiple` logic → extracted to `useExpansion` |
| Renderer registry | `components/timeline/renderers/*` | `DEFAULT_RENDERERS`, `resolveRenderer`, `TimelineContent` union — reused by `ScrollSpyTimeline` |
| Status | `components/shared/status-badge.tsx` | `StatusBadge` + `StatusColorRole` (subpath-exported; root collides with tool-ui) |
| shadcn | `components/shadcn/*` | `Card`, `Collapsible`, `Skeleton`, `Empty`, `Badge` |
| Virtualization | `@tanstack/react-virtual` | optional `ItemList` virtualization (mirrors data-grid/timeline) |
| Test conventions | `components/data-grid/__tests__/data-grid.vitest.tsx` | happy-dom + testing-library + `vitest-axe` `expect.extend` + axe assertion |

### Impact

- `timeline/use-timeline.ts` is refactored to delegate to `useExpansion` — **API-stable**.
- `lib/shared/index.ts`, `components/timeline/index.ts`, new `components/collection/index.ts`,
  and the root `src/index.ts` barrel gain exports.
- No DB / domain / service / app layers touched (pure UI library).

---

## 3. Implementation Plan (TDD)

Build order (each RED → GREEN → REFACTOR): **useExpansion → EntityCard/CardGrid → ItemList
→ useScrollSpy → ScrollSpyTimeline**, then refactor `useTimeline` onto `useExpansion`.

### Files

| File | Purpose |
|---|---|
| `lib/shared/use-expansion.ts` | Extracted headless expansion controller |
| `lib/shared/__tests__/use-expansion.vitest.ts` | Hook tests |
| `components/collection/entity-card.tsx` | Presentational card (icon/title/meta/status/actions) |
| `components/collection/card-grid.tsx` | Responsive auto-fill grid + selection + states |
| `components/collection/item-list.tsx` | Expandable rows + density + a11y + opt. virtualization |
| `components/collection/index.ts` | Collection sub-barrel |
| `components/collection/__tests__/card-grid.vitest.tsx` | CardGrid/EntityCard tests |
| `components/collection/__tests__/item-list.vitest.tsx` | ItemList tests |
| `components/timeline/use-scroll-spy.ts` | IntersectionObserver active-milestone hook |
| `components/timeline/scroll-spy-timeline.tsx` | Rail + markers + scroll-spy + sections |
| `components/timeline/__tests__/use-scroll-spy.vitest.ts` | Hook tests (IO mock) |
| `components/timeline/__tests__/scroll-spy-timeline.vitest.tsx` | Timeline tests (IO mock) |

### TDD test list (from §4a)

**`use-expansion.vitest.ts`** — toggle add/remove; `single` keeps one open, `multiple` keeps
many; controlled (`value`/`onChange`, no internal self-update); `defaultExpandedIds` initial;
`isExpanded`; per-item `onExpandedChange`.

**`card-grid.vitest.tsx` (§4a.1d)** — renders N cards; selection via click + keyboard
(Enter/Space); `aria-selected` reflects `selectedId`; loading → skeleton; empty → `Empty`;
`data-density`; column-width style applied; axe pass.

**`item-list.vitest.tsx` (§4a.2d)** — expand/collapse via click + keyboard; single vs
multiple mode; `aria-expanded`/`aria-controls` wiring; loading/empty; `data-density`;
virtualized → bounded DOM nodes on 1000 items; axe pass.

**`use-scroll-spy.vitest.ts` (§4a.3d)** — IntersectionObserver mock; active-index math
(topmost in-view entry); offset → `rootMargin`; `onActiveChange` fires on change.

**`scroll-spy-timeline.vitest.tsx` (§4a.3d)** — rail markers in desc/asc order; section
expand/collapse (uses `useExpansion`); active-milestone via mocked IO → `onActiveChange`;
sticky marker has `position:sticky`; renderer registry resolves markdown/image/code;
`prefers-reduced-motion` disables travel animation; loading/empty/error; accessible `<ol>`;
axe pass.

---

## 4. Implementation Summary

All three foundations + the extracted hook were built TDD-first (RED → GREEN → REFACTOR)
in the planned order (`useExpansion` → `EntityCard`/`CardGrid` → `ItemList` → `useScrollSpy`
→ `ScrollSpyTimeline`), then `useTimeline` was refactored onto `useExpansion`. Every
component is `cva` + `data-slot` + `cn()`, semantic-token-only, and exposes
loading/empty/error via `AsyncStateProps` and density via `data-density`.

### 4.1 §4a EXISTS-vs-spec coverage

| §4a requirement | Status | Where |
|---|---|---|
| **4a.1 EntityCard** — icon · title · meta · `StatusBadge` (dot+label) · actions; `selected`; standalone clickable (role=button, Enter/Space); density cva | ✅ | `collection/entity-card.tsx` |
| **4a.1 CardGrid** — responsive auto-fill `repeat(auto-fill, minmax(min,1fr))`; ARIA grid→row→gridcell; `selectedId`→`aria-selected`; roving tabindex (arrows/Home/End/Enter/Space); skeleton/empty/error; `data-density` | ✅ | `collection/card-grid.tsx` |
| **4a.2 ItemList** — full-width expandable rows → detail panel; `aria-expanded`/`aria-controls`; roving tabindex (Down/Up move, Right/Left expand/collapse, Enter/Space toggle); single/multiple via `useExpansion`; `onRowClick`; opt-in `@tanstack/react-virtual`; skeleton/empty/error; `data-density` | ✅ | `collection/item-list.tsx` |
| **4a.3 useScrollSpy** — `IntersectionObserver`; topmost-in-view active-index math; `offset`→`rootMargin`; `onActiveChange` fires only on change; `register(id)` ref factory | ✅ | `timeline/use-scroll-spy.ts` |
| **4a.3 ScrollSpyTimeline** — sticky marker rail (`position:sticky` at `stickyOffset`); desc/asc order; reuses renderer registry + `TimelineContent` for media/sections; collapsible sections via `useExpansion`; accessible `<ol>` fallback; `prefers-reduced-motion` disables travel/pulse; loading/empty/error; `data-density` | ✅ | `timeline/scroll-spy-timeline.tsx` |
| **Shared useExpansion** — extracted from `useTimeline`; controlled/uncontrolled; single/multiple; `defaultExpandedIds`; `isExpanded`/`toggle`/`setExpanded`; per-item `onExpandedChange` | ✅ | `lib/shared/use-expansion.ts` |
| `useTimeline` refactor (API-stable, no test changes) | ✅ | `timeline/use-timeline.ts` |
| Barrels (collection sub-barrel + timeline sub-barrel + root barrel) | ✅ | `collection/index.ts`, `timeline/index.ts`, `index.ts` |

### 4.2 Test evidence — `pnpm --filter @arcaai/ui test`

New TASK-378 specs (43 tests / 5 files):

| Spec | Tests |
|---|---|
| `lib/shared/__tests__/use-expansion.vitest.ts` | 6 |
| `collection/__tests__/card-grid.vitest.tsx` (incl. axe) | 11 |
| `collection/__tests__/item-list.vitest.tsx` (incl. axe) | 12 |
| `timeline/__tests__/use-scroll-spy.vitest.ts` (IO mock) | 4 |
| `timeline/__tests__/scroll-spy-timeline.vitest.tsx` (IO mock + axe) | 10 |

Full package suite (no regressions — pre-existing data-grid / timeline / live-transcript /
shared all green):

```
 Test Files  226 passed (226)
      Tests  488 passed (488)
   Duration  17.20s
```

### 4.3 Build evidence — `pnpm build --filter @arcaai/ui`

```
@arcaai/ui:build: ESM ⚡️ Build success in 2500ms
@arcaai/ui:build: CJS ⚡️ Build success in 2500ms
@arcaai/ui:build: DTS ⚡️ Build success in 21255ms
@arcaai/ui:build: ≈ tailwindcss v4.2.2 … Done in 235ms
 Tasks:    1 successful, 1 total
```

(The `"use client"` directive / unused-`@elevenlabs` warnings are pre-existing tsup bundle
notes, unrelated to this ticket.)

### 4.4 Lint evidence — `pnpm lint --filter @arcaai/ui`

```
@arcaai/ui:lint: > ESLINT_USE_FLAT_CONFIG=false eslint src --max-warnings 0
 Tasks:    1 successful, 1 total
```

0 errors, 0 warnings. (5 initial `prettier/prettier` wrap warnings in the new files were
auto-fixed with `eslint --fix`.)

### 4.5 Known non-issues (editor extension only)

The **Microsoft Edge Tools** in-editor linter flags dynamic inline `style={{…}}` (runtime
auto-fill column width, sticky `top` offset, virtualizer transforms) and dynamic
`aria-selected`/`aria-expanded`/`role="list"` expressions. These are static-analysis false
positives — identical patterns exist in the shipped `data-grid/` and `history-timeline-list`
components. The authoritative gates pass: project **ESLint** is clean and **`vitest-axe`**
reports **0 violations** for CardGrid, ItemList, and ScrollSpyTimeline.

---

## 5. Files Changed

### Created

| File | Purpose |
|---|---|
| `packages/ui/src/lib/shared/use-expansion.ts` | Headless expansion controller extracted from `useTimeline` |
| `packages/ui/src/lib/shared/__tests__/use-expansion.vitest.ts` | `useExpansion` tests (6) |
| `packages/ui/src/components/collection/entity-card.tsx` | Presentational card (icon/title/meta/status/actions, selectable) |
| `packages/ui/src/components/collection/card-grid.tsx` | Responsive auto-fill ARIA grid + selection + async states |
| `packages/ui/src/components/collection/item-list.tsx` | Expandable rows + roving tabindex + density + opt. virtualization |
| `packages/ui/src/components/collection/index.ts` | Collection sub-barrel |
| `packages/ui/src/components/collection/__tests__/card-grid.vitest.tsx` | CardGrid/EntityCard tests (11, incl. axe) |
| `packages/ui/src/components/collection/__tests__/item-list.vitest.tsx` | ItemList tests (12, incl. axe) |
| `packages/ui/src/components/timeline/use-scroll-spy.ts` | IntersectionObserver active-milestone hook |
| `packages/ui/src/components/timeline/scroll-spy-timeline.tsx` | Sticky marker rail + scroll-spy + collapsible sections |
| `packages/ui/src/components/timeline/__tests__/use-scroll-spy.vitest.ts` | `useScrollSpy` tests (4, IO mock) |
| `packages/ui/src/components/timeline/__tests__/scroll-spy-timeline.vitest.tsx` | ScrollSpyTimeline tests (10, IO mock + axe) |

### Modified

| File | Change |
|---|---|
| `packages/ui/src/components/timeline/use-timeline.ts` | Delegate expansion to `useExpansion` (public API unchanged) |
| `packages/ui/src/lib/shared/index.ts` | Export `useExpansion` + its types |
| `packages/ui/src/components/timeline/index.ts` | Export `ScrollSpyTimeline`, `useScrollSpy` + types |
| `packages/ui/src/index.ts` | Root barrel: collection components + ScrollSpyTimeline/useScrollSpy (useExpansion re-exported via `export * from './lib/shared'`) |

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-29 | Ticket created; plan authored from PHASE-2-PLAN §4a | this README |
| 2026-06-30 | Implemented all 3 foundations + `useExpansion` (TDD, 43 new tests); refactored `useTimeline` (API-stable); added barrels. Suite 488/488, build OK, lint clean. | see §5 |
