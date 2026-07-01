# TASK-377 — Shared Metrics / Reporting / Chart Component System

| | |
|---|---|
| **Ticket** | TASK-377 |
| **Type** | feature (`@arcaai/ui` primitives) |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Completed |
| **Scope** | `packages/ui` (`@arcaai/ui`) only — new `components/metrics/` folder + barrels. No app code. |
| **Spec** | [`PHASE-2-PLAN.md` §3](../TASK-371-Admin-Console-Redesign/PHASE-2-PLAN.md) (workstream #3) |
| **Parent** | [TASK-371 Admin Console Redesign](../TASK-371-Admin-Console-Redesign/README.md) |
| **Depends on** | TASK-378 collection foundations (`ItemList`, `useExpansion`), shadcn `chart`/`recharts@2.15.4`, `StatusBadge` |

---

## 1. Requirement Analysis

### Description

Build a small, semantic-token-driven **metrics** primitive set in `@arcaai/ui` under a
new `packages/ui/src/components/metrics/` folder. These are the reusable presentational
building blocks the **Dashboard (Figma frame 10)** and **Service Monitoring (frame 11)**
screens compose from. TASK-377 ships the **primitives only** — building the app
routes/screens and migrating `apps/admin/system-health.tsx` are separate app tickets
(PHASE-2-PLAN §3.4 step 10).

### The eight primitives (PHASE-2-PLAN §3.1 / §3.2)

| # | Component | File | Reuses |
|---|---|---|---|
| 1 | `StatusDot` | `status-dot.tsx` | `StatusColorRole` |
| 2 | `StatCard` | `stat-card.tsx` | `Card`, `Skeleton`, `AsyncStateProps` |
| 3 | `MetricChart` (bar/line/area) | `metric-chart.tsx` | shadcn `chart` shell + `recharts` |
| 4 | `ServiceStatusItem` + `ServiceStatusBar` | `service-status.tsx` | `StatusDot`, `StatusBadge`, `Popover`, `Button` |
| 5 | `DateRangeSelector` | `date-range-selector.tsx` | `ToggleGroup`, `Popover`, `Calendar`, `date-fns` |
| 6 | `TenantFilter` | `tenant-filter.tsx` | `Command`, `Popover`, `Button` |
| 7 | `MetricTable` | `metric-table.tsx` | shadcn `Table`, `Skeleton`, `Empty` |
| 8 | `RunningTasksList` + `ModelsList` | `running-tasks-list.tsx`, `models-list.tsx` | TASK-378 `ItemList`, `StatusDot`, `Progress`, `StatusBadge` |

### Business context

The HOPE Admin Console needs cross-tenant observability (KPIs, charts, service health,
per-service metrics, live model/task lists). PHASE-2-PLAN grounded these against the real
SDK hooks (`useMonitoring`, `useHealthCheck`) and confirmed gaps (no P95 latency,
requests/min, or error-rate in the API today) — so the primitives accept that data via
props and **hide cells when the data is absent** rather than fabricate it.

### Acceptance criteria

- 8 primitives implemented exactly to §3.2 (props, cva variants, tokens, loading/empty/error, a11y, responsive).
- Semantic tokens **only** — no hardcoded colors (no `text-green-600`/emerald/rose).
- Status is **dot + label**, never color-only; deltas pair a `TrendingUp/Down/Minus` icon + sign, never color-only.
- WCAG 2.2 AA, ≥44px interactive targets, visible focus, `tabular-nums` for numerics, `font-mono` for IDs/versions, `prefers-reduced-motion` honored, two density modes via `data-density`.
- Vitest coverage for every §3.5 bullet incl. `vitest-axe` where specified.
- Barrel-exported; the pre-existing 488 `@arcaai/ui` tests stay green; build + lint pass.

---

## 2. Current State Evaluation

### Reused (not rebuilt)

- **shadcn `chart` shell** (`components/shadcn/chart.tsx`): `ChartContainer`, `ChartConfig`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent` wrapping `recharts@2.15.4`. `ChartContainer` already injects `--color-<key>` CSS vars via a `<style>` tag and wraps a `ResponsiveContainer`. `MetricChart` wraps this and only touches the recharts chart components (`BarChart`/`LineChart`/`AreaChart`, `Bar`/`Line`/`Area`, axes, grid).
- **`--chart-1..5`** tokens already defined in `styles/globals.css` (light + dark + `@theme --color-chart-*`). Series default to these via `var(--chart-N)`.
- **`StatusBadge` + `StatusColorRole`** (`components/shared/status-badge.tsx`) — `StatusDot` reuses the `StatusColorRole` union. `StatusBadge` is intentionally off the root barrel (tool-ui name collision); imported from the `components/shared` subpath.
- **TASK-378 `ItemList`** (`components/collection/item-list.tsx`) — `RunningTasksList`/`ModelsList` are thin presets over `ItemList`.
- **`lib/shared`** contracts: `AsyncStateProps`, `BaseSurfaceProps`, `Density`, `DENSITY_ROW_HEIGHT`.
- shadcn primitives: `Card`, `Skeleton`, `Empty`, `Table`, `Select`, `Popover`, `Command`, `Calendar`, `ToggleGroup`, `Progress`, `Badge`, `Button`. `date-fns@3.6` (`startOfWeek/Month/Year`, `endOf*`, `formatDistanceToNow`).

### Reference only (untouched)

- `components/custom/service-status-bar.tsx` — the **old** bar with hardcoded emerald/amber/red. Left untouched (apps/admin still imports it); used only as a behavioral reference. The metrics `ServiceStatusBar` is the new **canonical, semantic-token** version.

### Test + barrel conventions

- Vitest glob `src/**/*.vitest.{ts,tsx}` (happy-dom + `@testing-library/react` + `vitest-axe`). Patterns copied from `components/collection/__tests__/*` and `data-grid/__tests__/data-grid.vitest.tsx` (ResizeObserver + `getBoundingClientRect` shims for virtualization/recharts; axe with `color-contrast` disabled).
- Root barrel `src/index.ts` (TASK-372 canonical block at the bottom) uses **explicit named exports** for collision-prone modules — mirrored here.

---

## 3. Implementation Plan

### Build order (PHASE-2-PLAN §3.4)

`StatusDot → StatCard → MetricChart → ServiceStatusItem/Bar → DateRangeSelector → TenantFilter → MetricTable → RunningTasksList/ModelsList → barrels`.

TDD Red→Green→Refactor per component (`.cursor/rules/01-development-workflow.mdc`).

### TDD test list (PHASE-2-PLAN §3.5)

- **StatusDot** — role/aria per color role; `pulse` gated by `prefers-reduced-motion` (`motion-reduce` class); decorative (`aria-hidden`) vs labelled (`aria-label`); size variants.
- **StatCard** — renders value/label/hint; delta up/down/neutral shows icon + sign (color-blind safe); `deltaIntent="negative"` flips success/destructive mapping; loading→skeleton, empty→`—`, error→errorState; `data-density`; axe pass.
- **MetricChart** — renders bar/line/area for given series; emits `--chart-*` vars via ChartStyle; loading→skeleton / empty→`Empty` / error→errorState+retry; sr-only data-table fallback present; `role="img"` + descriptive `aria-label`; axe pass.
- **ServiceStatusBar** — maps healthy/degraded/unhealthy → correct dot + badge; hides P95 cell when `p95Ms` undefined; `role="status"`/`aria-live="polite"`; refresh fires `onRefresh` and is a real ≥44px button; collapses to a summary chip on narrow widths (Popover); axe pass.
- **DateRangeSelector** — preset click emits correct `{from,to,preset}` (week/month/year via date-fns); custom preset opens a range Calendar; active preset reflected; keyboard nav.
- **TenantFilter** — search filters list; "All tenants" only when `allowAll`; disabled state locks selection (tenant-admin pinned); current selection ✓; ≥44px combobox trigger.
- **MetricTable** — `<th scope="col">` + caption; numeric columns right-aligned `tabular-nums`; loading→skeleton rows; empty state.
- **RunningTasksList** — status dot + name + mono id + progress + relative time; empty/loading. **ModelsList** — status badge + size/version columns.

### Barrel + collision plan

- New sub-barrel `components/metrics/index.ts` (`export *`, includes the canonical `ServiceStatusBar`).
- Root `src/index.ts`: explicit named exports of the non-colliding metrics primitives.
- **`ServiceStatusBar` name collision** (see §5).
- Add `./components/metrics` to `package.json` `exports` + a tsup entry, mirroring the `components/shared` precedent.

---

## 4. Implementation Summary

All eight primitives were built TDD-first (RED → GREEN → REFACTOR) in the §3.4 order.
Everything lives under `packages/ui/src/components/metrics/`; only `@arcaai/ui` was touched.

### Files created

| File | Purpose |
|---|---|
| `metrics/status-dot.tsx` | Semantic status atom — `StatusColorRole` dot, `prefers-reduced-motion` pulse, decorative vs labelled. |
| `metrics/stat-card.tsx` | KPI tile — value/label/hint, delta (icon + sign, `deltaIntent` flips mapping), loading/empty/error, `data-density`. |
| `metrics/metric-chart.tsx` | bar/line/area chart wrapping the shadcn `chart` shell + recharts; `--chart-*` series; `role="img"` + sr-only `<table>` fallback; loading/empty/error+retry. |
| `metrics/service-status.tsx` | `ServiceStatusItem` (dot + name + `StatusBadge` + optional P95/uptime/version) and **canonical** `ServiceStatusBar` (`role="status"`/`aria-live`, ≥44px refresh, narrow-width Popover summary chip). |
| `metrics/date-range-selector.tsx` | `ToggleGroup` presets + custom-range `Calendar` Popover; emits `{from,to,preset}` via date-fns. |
| `metrics/tenant-filter.tsx` | Searchable `Command`+`Popover` combobox; `allowAll` → "All tenants"; `disabled` pins tenant-admin; current ✓; ≥44px trigger. |
| `metrics/metric-table.tsx` | Thin shadcn `Table` wrapper — `<th scope="col">` + caption, numeric `tabular-nums` right-align, skeleton rows, empty/error. |
| `metrics/running-tasks-list.tsx` | `ItemList` preset — `StatusDot` + name + mono id + `Progress` + relative time. |
| `metrics/models-list.tsx` | `ItemList` preset — adds `StatusBadge` + size + mono version columns. |
| `metrics/index.ts` | Metrics sub-barrel (`@arcaai/ui/components/metrics`) — full set incl. canonical `ServiceStatusBar`. |
| `metrics/__tests__/*.vitest.tsx` | 9 vitest suites (happy-dom + testing-library + vitest-axe), one per primitive group. |

### Files modified

| File | Change |
|---|---|
| `packages/ui/src/index.ts` | Added TASK-377 block — root-exports all metrics primitives **except** the colliding `ServiceStatusBar`/`ServiceStatusBarProps` (see §5). |
| `packages/ui/package.json` | Added `"./components/metrics"` to `exports` (types/import/require → `dist/components/metrics/index.*`). |
| `packages/ui/tsup.config.ts` | Added `src/components/metrics/index.ts` as a third tsup entry (subpath dist + `.d.ts`). |

### §3 spec coverage

- **Semantic tokens only** — every color resolves to a token (`bg-success`, `text-destructive`, `text-warning`, `text-muted-foreground`, `var(--chart-N)`); no `text-green-600`/emerald/rose. Status is **dot + label**, deltas pair `TrendingUp/Down/Minus` + sign (never color-only).
- **a11y** — WCAG 2.2 AA; ≥44px targets (`min-h-11` triggers/refresh); visible `focus-visible:ring`; `prefers-reduced-motion` via `motion-safe`/`motion-reduce`; `MetricChart` is `role="img"` + descriptive `aria-label` + sr-only data `<table>`; `ServiceStatusBar` is `role="status"`/`aria-live="polite"`; `vitest-axe` clean on every primitive.
- **numerics/ids** — `tabular-nums` everywhere numeric; `font-mono` for ids/versions/keys.
- **density** — `data-density` on `StatCard`, `MetricChart`, `MetricTable`, and the `ItemList`-backed lists.
- **AsyncStateProps** — `StatCard`, `MetricChart`, `MetricTable`, `RunningTasksList`, `ModelsList` honor the shared loading/empty/error contract.

### Verification evidence (actual output)

**`pnpm --filter @arcaai/ui test`** (full suite — no regression; 488 pre-existing + 73 new):

```
 Test Files  235 passed (235)
      Tests  561 passed (561)
```

Metrics-only (`vitest run src/components/metrics`): `Test Files 9 passed (9) · Tests 73 passed (73)`.

**`pnpm build --filter @arcaai/ui`** (tsup + tailwind):

```
ESM dist/components/metrics/index.mjs     76.17 KB
CJS dist/components/metrics/index.js      80.44 KB
DTS dist/components/metrics/index.d.ts    976.00 B
ESM ⚡️ Build success · CJS ⚡️ Build success · DTS ⚡️ Build success
tailwindcss v4.2.2 → Done
 Tasks:    1 successful, 1 total
```

**`pnpm lint --filter @arcaai/ui`** (`eslint src --max-warnings 0`): **0 errors, 0 warnings** —

```
 Tasks:    1 successful, 1 total
```

(10 initial `prettier/prettier` formatting warnings were auto-fixed with `eslint --fix`.)

### Deviations (with rationale)

1. **TenantFilter uses controlled filtering** (`shouldFilter={false}` + filter the array by a controlled query). cmdk's built-in fuzzy filter does **not** run under happy-dom (its internal scheduler never flushes — verified: the input updates but items don't filter). Controlled filtering is a standard cmdk pattern, is deterministic, and behaves identically for users while being fully testable.
2. **Progress `aria-valuenow` set at the call site** in `RunningTasksList`. The local shadcn `Progress` destructures `value` only to compute the indicator transform and never forwards it to the Radix `Progress.Root`, so Radix reports `data-state="indeterminate"` and omits `aria-valuenow`. Modifying the shadcn primitive is out of scope, so the list passes `aria-valuenow/min/max` itself to keep the bar an accessible determinate progressbar.
3. **happy-dom test adaptations** — `DateRangeSelector` keyboard-nav asserts the WAI-ARIA radio-group structure (Radix roving focus needs real browser layout); its custom-range test asserts a valid emitted `{from,to}` rather than exact day numbers (react-day-picker range behavior under happy-dom). `TenantFilter` "All tenants" assertions scope to `role="option"` because the trigger label legitimately repeats that text.
4. **Microsoft Edge Tools IDE notes (non-blocking, not the gate)** — the Edge Tools extension flags dynamic `aria-expanded={open}` (combobox) and a dynamic inline `style={{ height }}` (chart sizing) as it can't evaluate JS expressions. Both are dynamic-value false positives that already exist across the repo (`voice-picker.tsx` uses `role="combobox" aria-expanded={isOpen}`; `ItemList`/virtualization use inline heights) and are **not** flagged by the project's eslint gate, which passes with 0 warnings.

### Follow-ups (out of scope — app tickets)

- Build the Dashboard (frame 10) + Service Monitoring (frame 11) screens that compose these primitives.
- Migrate `apps/admin/system-health.tsx` onto `StatCard`/`ServiceStatusBar`, switching its import to `@arcaai/ui/components/metrics`; afterwards the legacy `custom/service-status-bar.tsx` can be retired and the root-barrel collision dissolves.
- Optional primitive ticket: fix the shadcn `Progress` to forward `value` to the Radix root so deviation #2's call-site workaround can be dropped.

---

## 5. ServiceStatusBar barrel-name collision

**The collision.** The root barrel already re-exports the legacy bar via
`export * from './components/custom/service-status-bar'`, which exposes
`ServiceStatusBar` + `ServiceStatusBarProps` (hardcoded emerald/amber/red, still
imported by `apps/admin`). The new canonical semantic `metrics/ServiceStatusBar`
shares those names.

**Resolution (StatusBadge precedent).** The metrics `ServiceStatusBar` /
`ServiceStatusBarProps` are **deliberately NOT re-exported from the root barrel**.
Instead:

- The root `src/index.ts` exports every metrics primitive **except** those two names
  (so `ServiceStatusItem`, `StatusDot`, `StatCard`, `MetricChart`,
  `DateRangeSelector`, `TenantFilter`, `MetricTable`, `RunningTasksList`,
  `ModelsList` + their types are available from `@arcaai/ui`).
- The full set — **including the canonical `ServiceStatusBar`** — ships via the new
  subpath **`@arcaai/ui/components/metrics`** (new `package.json` `exports` entry +
  tsup entry → `dist/components/metrics/index.{js,mjs,d.ts}`).

**Why.** This mirrors how `StatusBadge` (tool-ui collision) and the `LiveTranscript`
sub-components are handled, avoids a breaking change to the legacy root export that
`apps/admin` depends on, and gives the canonical bar one obvious, intentional import
path. When the app migrates (separate ticket) it switches to
`import { ServiceStatusBar } from '@arcaai/ui/components/metrics'`.

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-30 | Initial plan + analysis | this README |
| 2026-06-30 | Built all 8 primitives TDD-first; added metrics sub-barrel + root exports + `./components/metrics` subpath (package.json/tsup); resolved `ServiceStatusBar` collision via subpath. Full suite 561/561, build + lint green. | `metrics/*`, `src/index.ts`, `package.json`, `tsup.config.ts` |
