# TASK-429 — Data Grid Cell Overflow Paints Over Row Borders

| Field | Value |
| --- | --- |
| Status | Completed |
| Type | bugfix |
| Owner | Admin Console / UI |
| Affected packages | `packages/ui`, `apps/admin-console` |
| Related | TASK-423 (Data Grid Standardization), TASK-427 (Screen Template Standardization) |

## Requirement Analysis

On the AI Model Registry screen (and any grid whose cells can wrap), row borders visually disappear
under certain cells and wrapped content is clipped mid-badge by the next row (user screenshot,
2026-07-06). Requirement: restore consistent row borders across ALL admin-console data grids and make
the affected cell renderers conform to the grid's single-line design.

## Current State Evaluation (root cause)

All admin-console tables share one stack: `AdminDataGrid` → `VirtualizedDataGrid`
(`packages/ui/src/components/data-grid/virtualized-data-grid.tsx`). It is a fixed-height virtualized
grid: rows are absolutely-positioned `div`s of exactly `DENSITY_ROW_HEIGHT` (48px comfortable / 36px
compact); the virtualizer never measures content. The row divider is a single `border-b` on the row.

Cells (`data-slot="data-grid-cell"`) are designed single-line (`truncate`) but have **no height
constraint** — they size to content and are vertically centered (`items-center` on the row). When a
cell renderer wraps (`flex flex-wrap` badges, `flex flex-col` stacks), the cell grows taller than the
row box. Because the cell has an opaque background (`bg-inherit` → `bg-card`), the overflow paints
over the 1px `border-b` of its own row and the previous row — the border "disappears" — while the
next row (painted later) clips the bottom line of content.

Wrap-capable cell renderers found (full audit, 2026-07-06):

| Screen | File:line | Cell |
| --- | --- | --- |
| AI Models | `features/ai-models/components/ai-models-screen.tsx:127` | Capability — `flex flex-wrap`, 2 badges (the screenshot) |
| Entitlements → Plans | `features/entitlements/components/entitlements-screen.tsx:123` | Features — `flex flex-wrap`, uncapped badge list |
| Users list | `features/users/components/users-list-screen.tsx:67` | Roles — `flex flex-wrap` (capped +N, still wraps) |
| API Keys | `features/api-keys/components/api-keys-screen.tsx:49` | Scopes — `flex flex-wrap` (capped +N, still wraps) |
| Rate Limits (tiers + routes) | `features/rate-limits/components/rate-limits-screen.tsx:43` | Sources — `flex flex-wrap`, 2 badges |
| Storage → Access Keys | `features/storage/components/access-keys-tab.tsx:151` | Name — `flex flex-col`, 2 stacked lines |

Constraint discovered during analysis: the fix must NOT be `overflow-hidden` on the **row** — pinned
columns rely on `position: sticky` cells sticking to the outer scroll container
(`getColumnPinningStyle`, `packages/ui/src/lib/data-table.ts`); `overflow-hidden` on the row would
make the row the scroll container and break pinning.

## Implementation Plan

Two layers, TDD (failing test first per change):

### 1. Grid-level guard — `packages/ui` (protects all ~30 grid usages)

- **Test (RED)**: `packages/ui/src/components/data-grid/__tests__/data-grid.vitest.tsx` — body cells
  are height-constrained to the fixed virtual row (`h-full` on `data-slot="data-grid-cell"`), so
  oversized content clips inside the row instead of painting over `border-b`.
- **Implement (GREEN)**: add `h-full` to the gridcell class in `virtualized-data-grid.tsx` (`BodyRow`).
  The cell already carries `overflow:hidden` via `truncate`; a definite height makes the clip
  effective vertically.

### 2. Per-screen cell fixes — `apps/admin-console` (content stays legible, not just clipped)

| Screen | Change | Test (extend existing `__tests__` file) |
| --- | --- | --- |
| AI Models | Capability cell: drop `flex-wrap` (single line); widen column `size` 220 → 280 so "automatic speech recognition" + category fit | capability cell container is single-line (no `flex-wrap`) |
| Entitlements | Features cell: drop `flex-wrap`; cap at 2 badges + `+N` overflow (matches Roles/Scopes pattern); widen column 220 → 260 | 3 enabled features render 2 badges + `+1`, single-line |
| Users list | `RolesCell`: drop `flex-wrap` (already capped +N) | roles cell container is single-line |
| API Keys | `ScopeBadges`: drop `flex-wrap` (already capped +N) | scopes cell container is single-line |
| Rate Limits | `SourceBadges`: drop `flex-wrap` (2 badges) | sources cell container is single-line |
| Storage Access Keys | Name cell: `flex-col` two-line → one line, name + muted description inline, both `truncate` | name + description render in a single-line container |

### Verification criteria

- `pnpm --filter @arcaai/ui test` and `pnpm --filter @arcaai/ui build lint` green.
- `pnpm --filter @arcaai/admin-console test` (or targeted vitest run) and `build lint` green.
- No new lint warnings (only-warn in `packages/*` treated as errors).
- Visual spot-check of AI Model Registry in the running dev app (`pnpm dev:admin`, port 5176):
  borders continuous on every row, both themes.

## Implementation Summary

Implemented exactly per plan, TDD (every test seen RED before its fix).

### Files changed

| File | Change |
| --- | --- |
| `packages/ui/src/components/data-grid/virtualized-data-grid.tsx` | Added `h-full` to the `data-grid-cell` class in `BodyRow` — cells are now height-capped to the virtual row, so oversized content clips inside the row instead of painting over `border-b`. Pinned-column stickiness untouched. |
| `packages/ui/src/components/data-grid/__tests__/data-grid.vitest.tsx` | New test: body cells carry `h-full` + `truncate` (the single-line clip contract). |
| `apps/admin-console/src/features/ai-models/components/ai-models-screen.tsx` | Capability cell: dropped `flex-wrap`; column `size` 220 → 280. |
| `apps/admin-console/src/features/entitlements/components/entitlements-screen.tsx` | Features cell: dropped `flex-wrap`; capped at `FEATURE_BADGE_LIMIT = 2` + `+N` overflow badge; column `size` 220 → 260. |
| `apps/admin-console/src/features/users/components/users-list-screen.tsx` | `RolesCell`: dropped `flex-wrap` (already +N-capped). |
| `apps/admin-console/src/features/api-keys/components/api-keys-screen.tsx` | `ScopeBadges`: dropped `flex-wrap` (already +N-capped). |
| `apps/admin-console/src/features/rate-limits/components/rate-limits-screen.tsx` | `SourceBadges`: dropped `flex-wrap` (used by both tiers and routes grids). |
| `apps/admin-console/src/features/storage/components/access-keys-tab.tsx` | Name cell: two-line `flex-col` → single line, name + muted description inline, each `truncate`. |
| 6 × `__tests__/*.test.tsx` (one per screen above) | New TASK-429 regression tests asserting the single-line cell contract (and the entitlements `+1` capping behavior). |

No migrations, no API changes.

### Verification evidence (2026-07-06)

- `pnpm --filter @arcaai/ui test` — `Test Files 238 passed (238) · Tests 622 passed (622)`
- `pnpm --filter @arcaai/ui lint` — clean (`--max-warnings 0`); `build` — tsup + tailwind OK
- `pnpm --filter @arcaai/admin-console test` — `Test Files 80 passed (80) · Tests 574 passed (574)`
- `pnpm --filter @arcaai/admin-console lint` — clean; `build` — `next build` OK
- Runtime check on `pnpm dev:admin` (super_admin, working tenant ArcaAI, `/ai-models`, 56 models):
  capability badges single-line, all row borders continuous, rows uniform height — both themes.
  Screenshots in `evidence/` (`before-ai-models-broken-borders.png`, `after-ai-models-dark.png`,
  `after-ai-models-light.png`).

## Change History

| Date | Change |
| --- | --- |
| 2026-07-06 | Ticket opened; root-cause analysis + plan (approved in chat) |
| 2026-07-06 | Implemented grid `h-full` cell guard + 6 single-line cell renderers (TDD); all suites/lint/build green; runtime verified both themes; status → Completed |
