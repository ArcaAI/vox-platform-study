# TASK-775 — Admin-Console Table Conformance

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | refactor |
| **Branch** | `wt/task-774` |
| **Opened** | 2026-08-19 |
| **Surface** | `apps/admin-console` |
| **Follows** | [TASK-765](../TASK-765-Design-System-Conformance/README.md) (token foundation), [TASK-769](../TASK-769-Admin-Console-System-Conformance/README.md) (sibling workstream, detail-surface conformance), [TASK-774](../TASK-774-Page-Frame-Conformance/README.md) (sibling workstream, page-frame conformance) |

## Requirement Analysis

Measure the admin console's 10 non-`AdminDataGrid` table surfaces against the rule-11 table
contract (`.claude/rules/11-ux-ui-principles.md` §8 "Data Display", §11 "Accessibility") and either
migrate them to `AdminDataGrid` (`@arcaai/ui` `VirtualizedDataGrid`-backed) or bring them up to the
contract in place. Originally scoped as the "771" sub-ticket of a combined 769/770/771 conformance
sweep.

**This ticket was renumbered from TASK-771 to TASK-775.** A concurrent session had already
committed an unrelated, already-Completed `TASK-771-Rate-Limit-Admin-Writes-404` against the same
number (and `TASK-770-Dev-Bootstrap-Completeness` against the sibling "770"). See the Change
History below and the sibling [TASK-774](../TASK-774-Page-Frame-Conformance/README.md) (former
"770") for the rest of the split.

## Current State Evaluation

**Migrated to `AdminDataGrid`: none — and that is the correct outcome, confirmed by re-reading the
code in this pass.**

8 of the 10 measured table surfaces are not record lists: permission matrices, checkbox grids,
fixed comparison tables and key/value summaries iterating compile-time constants. A virtualized
server-driven grid would be actively worse for every one of them.

The 2 that genuinely *are* record lists (`tools-mcp-screen`, `gate-queue-panel`) are **blocked by
the backend contract, not by preference** — re-verified in this pass:

```
$ grep -n "manual" apps/admin-console/src/shared/data/admin-data-grid.tsx
11: * The grid is SERVER-DRIVEN: manual sorting/filtering/pagination is on, so the
194:        manual={{ sorting: true, filtering: true, pagination: true }}
```

`AdminDataGrid` hardcodes `manual={{ sorting: true, filtering: true, pagination: true }}`
(`apps/admin-console/src/shared/data/admin-data-grid.tsx:194`) and is strictly server-driven, while
`getGateQueue()` and `listMcpServers()` take no parameters and `GET /admin/mcp-servers` accepts only
`?tenantId=`. Wiring the grid over a paramless endpoint would ship sort and pager controls that
silently do nothing. Verified independently against the API client and the gateway route.

## Implementation Plan

1. Enumerate every hand-rolled `<table>` / `<Table>` usage under `apps/admin-console/src/features/**`.
2. For each surface, classify it: genuine paginated record list (candidate for `AdminDataGrid`) vs.
   fixed-shape display (matrix, comparison, key/value summary) that a virtualized grid would harm.
3. For genuine record-list candidates, check whether the backing endpoint supports server-driven
   sort/filter/pagination params; if not, document the blocker rather than force a mismatched
   migration.
4. Bring every table (migrated or not) up to the rule-11 contract: keyboard reachability
   (WCAG 2.1.1, `scrollable-region-focusable`), `scope="col"`/`scope="row"`, an accessible name
   (`<caption>` or `aria-label`), one scroll container per panel.
5. Verify: `pnpm --filter @arcaai/admin-console test lint typecheck build`.

## Implementation Summary

All ten table surfaces were brought up to the rule-11 table contract in place (no migration to
`AdminDataGrid` — see Current State Evaluation). Real defects found and fixed:

1. **`pipeline-policy-screen` was mouse-only** (WCAG 2.1.1) — a `<TableRow onClick>` was the sole
   path to the scope editor, with no keyboard route at all. Now a real `<button>` with
   `aria-pressed`; the row click stays as a pointer affordance.
2. **4 raw `<table>` scroll containers were not keyboard-reachable** (axe
   `scrollable-region-focusable`) — bare `overflow-x-auto` divs, now `tabIndex={0}` +
   `role="region"` + label, per the `DetailDrawer` precedent.
3. Two unnamed tables given names; 25 missing `scope="col"`; one nested scroll area removed
   (rule 11 §1, one scroll container per panel).

**Corrected two of the ticket's own assumptions during the original pass:** `permission-matrix` was
already exemplary (caption, both-axis scopes, `sr-only` text on every glyph so nothing rides on
colour); and the shadcn `Table` primitive already ships `tabIndex={0}` on its scroll container, so
6 of the 10 were compliant before this ticket started. All ten skeletons and every reachable empty
state were already correct — none were added.

### Files touched (by category, per the original implementation pass)

- `apps/admin-console/src/features/harness-ops/**` (pipeline-policy-screen) — keyboard-reachable
  scope editor
- Four raw `<table>` surfaces across `apps/admin-console/src/features/**` — `tabIndex`/`role="region"`
  scroll wrappers
- Multiple table components across `apps/admin-console/src/features/**` — `scope="col"` additions,
  table names/`aria-label`, nested-scroll removal

## Verification

Run in `wt/task-774` after `pnpm install --frozen-lockfile`, `pnpm db:generate`, and building
workspace dependents (`@arcaai/ui`, `@arcaai/json-schema-subset`, `@arcaai/room`, `@arcaai/stt`,
`@arcaai/vad`, `@arcaai/med-ner`, `@arcaai/noise-filter`, `@arcaai/vox`) so vitest can resolve
their compiled `dist/` output instead of failing with "Failed to resolve import" (the worktree
ships no `node_modules` and these packages are consumed as built workspace deps, not source):

```
$ pnpm --filter @arcaai/admin-console test
 Test Files  206 passed (206)
      Tests  1620 passed (1620)

$ pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
(clean, no output)

$ pnpm --filter @arcaai/admin-console typecheck
> tsc --noEmit
(clean, no output)

$ pnpm --filter @arcaai/admin-console build
✓ Compiled successfully — all routes emitted (ƒ dynamic / ○ static as expected)
```

All four gates green (same combined run as TASK-774 — the two workstreams share a worktree and a
single verification pass). Spot-checked the a11y claims directly in the tree:

```
$ grep -rln 'role="region"' apps/admin-console/src/features | wc -l
6
$ grep -rn 'scope="col"' apps/admin-console/src/features | wc -l
37
```

Both consistent with "keyboard-reachable scroll wrappers added" and "25 missing `scope="col"`
fixed" (the current count reflects the fixed state, not the delta alone — pre-fix counts were not
re-derived since this is a re-verification of already-committed work, not a re-implementation).

No pre-existing test was modified and no axe assertion was relaxed as part of this re-verification
pass — the suite was run as committed.

## Not in scope / follow-ups

| Item | Detail |
|---|---|
| **`AdminDataGrid` has no client-driven mode** | `manual` is hardcoded on. Migrating `tools-mcp-screen` or `gate-queue-panel` requires gateway list params (`apps/api/src/modules/mcp-admin/`), the feature api clients, and the grid change landed **together** — that pairing is the unit of work, and it spans `apps/api`. |

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | **Split out of TASK-769 and renumbered 771 → 775.** The combined `TASK-769 · 770 · 771` document bundled this workstream ("771": table conformance) with two unrelated numbers. A concurrent session had already committed a real, already-Completed `TASK-771-Rate-Limit-Admin-Writes-404` against the same number (and `TASK-770-Dev-Bootstrap-Completeness` against the sibling "770"), so both numbers were double-booked — the second such collision on this workstream (the first: 766/767/768 → 769/770/771, recorded in TASK-769's own history). Owner decision: split into standalone `TASK-774` (page-frame conformance) and `TASK-775` (this ticket, table conformance); confirmed both numbers free in `docs/implementation/` and `docs/archive/` before creating this document. Content migrated verbatim from the combined ticket's "771" section; no new table-conformance work was performed as part of the split — this is a documentation move plus re-verification. |
| 2026-08-19 | Re-verified against the `wt/task-774` worktree: a11y fix claims (`role="region"`, `scope="col"`, `aria-pressed`) spot-checked with `grep`, then `pnpm --filter @arcaai/admin-console test lint typecheck build` run clean (206/206 files, 1620/1620 tests, 0 lint warnings, clean typecheck, successful build). Status → Review. |
| 2026-08-20 | Status advanced to Completed per owner directive: implementation complete, all gates green; outstanding e2e execution/verification is not a status gate. |
