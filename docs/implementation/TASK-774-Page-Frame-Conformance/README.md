# TASK-774 — Admin-Console Page-Frame Conformance

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | refactor |
| **Branch** | `wt/task-774` |
| **Opened** | 2026-08-19 |
| **Surface** | `apps/admin-console` |
| **Follows** | [TASK-765](../TASK-765-Design-System-Conformance/README.md) (token foundation), [TASK-769](../TASK-769-Admin-Console-System-Conformance/README.md) (sibling workstream, detail-surface conformance) |

## Requirement Analysis

Bring every admin-console screen up to the `ScreenTemplate` / `StatusFooter` page-frame contract
defined in `.claude/rules/11-ux-ui-principles.md` §1 ("Screen Template", Figma frame `09 - Screen
Templates`) and the rule-10 skeleton-loading contract (`.claude/rules/10-skeleton-loading.md`).
Originally scoped as the "770" sub-ticket of a combined 769/770/771 conformance sweep.

**This ticket was renumbered from TASK-770 to TASK-774.** A concurrent session had already
committed an unrelated, already-Completed `TASK-770-Dev-Bootstrap-Completeness` against the same
number, and `TASK-771-Rate-Limit-Admin-Writes-404` was similarly double-booked. The combined
769/770/771 ticket document mixed this workstream in with two others under numbers that collided
with real, unrelated tickets. See the Change History below and the sibling
[TASK-775](../TASK-775-Table-Conformance/README.md) (former "771") for the rest of the split.

### Scope (as measured before starting, migrated verbatim from the original combined ticket)

| Gap | Measured |
|---|---|
| Screens without `ScreenTemplate` | 8 |
| Screens without `StatusFooter` | 12 |
| Rule-10 loading violations (bare `Loading…` text instead of `<Skeleton>`) | 2 |

A broader pre-measurement of rules 10/11 elsewhere in the console found it already conformant
(194 files use `<Skeleton>`, 118 `<Spinner>` vs 1 legitimate exception, 104 files use the `Empty`
family, 422 `toast.success/error` call sites, 0 hardcoded color literals) — so this ticket's real
scope was narrowly the page-frame gaps above, not a general sweep.

## Current State Evaluation

Re-verified 2026-08-19 in the `wt/task-774` worktree, against the tree as committed (the work
below was already implemented under the collided "770" number and is being re-homed to this
ticket, not re-done):

```
$ grep -rl "ScreenTemplate" apps/admin-console/src/features apps/admin-console/src/app | wc -l
66
$ grep -rl "StatusFooter" apps/admin-console/src/features apps/admin-console/src/app | wc -l
61
```

Both counts are consistent with the implementation summary below (screens adopted the template
either directly or already had it before this ticket started; the counts reported here are the
console-wide totals, not the delta this ticket alone produced — the delta is in the Implementation
Summary).

## Implementation Plan

1. Inventory every route under `apps/admin-console/src/app/**` and `src/features/**` screen
   components against the `ScreenTemplate` region contract.
2. For each screen missing `ScreenTemplate`: adopt it with the correct `contentMode` (`scroll` vs
   `fill`), or record an explicit, commented exemption when the screen genuinely has no console
   shell to pin against (auth screens) or would create a nested frame (a wrapper screen whose real
   frame lives one level down).
3. For each screen missing `StatusFooter`: add it in the pinned footer slot; where a status line
   already existed in the wrong region (in-tab, toolbar, or a bespoke footer component), move it
   into the slot rather than duplicating it.
4. Fix the 2 rule-10 loading violations (bare `Loading…` text) with `<Skeleton>` compositions
   matching the loaded shape.
5. Verify: `pnpm --filter @arcaai/admin-console test lint typecheck build`.

## Implementation Summary

**`ScreenTemplate` adopted on 6** screens: four playground surfaces at `contentMode="scroll"`,
`consultation-demo` at `fill` (its `ResizablePanelGroup` owns the height and the columns scroll
internally), plus `workbench`. Pinned header/tabs/toolbar are width-matched to the
`PlaygroundCanvas` caps (760 / 1100 / 1440px) so they stay aligned with the work column. No
`position: sticky` was introduced — pinned regions remain `shrink-0` flex rows, preserving the
WCAG 2.4.11 property that makes `ScreenTemplate` worth having.

**3 exemptions, each with an in-file comment:**

- `auth/verify-email-screen`, `auth/reset-password-screen` — they render under `app/(auth)/*/page.tsx`
  inside a bare centred `<main>`, with **no `(auth)` layout at all**: no `SidebarProvider`, no
  `SiteHeader`, no banners. `ScreenTemplate` is a `min-h-0 flex-1` column that assumes the console
  shell's content region; there is none and no chrome to pin. Login and register follow the same
  centred-card frame.
- `knowledge-documents-screen` — an audit false positive during the original scoping. The file is a
  bare `WorkingTenantGate` wrapper; the real frame (`ScreenTemplate contentMode="fill"` +
  `StatusFooter` around a `VirtualizedDataGrid`) already exists one level down in
  `knowledge-documents-list.tsx`. Adding a template here would nest two frames and two scroll
  containers.

**`StatusFooter` added to 5, moved into the slot on 3, skipped on 1.** Three screens already had
status lines living in the wrong region (an in-tab `footerStatus()`, a toolbar `FOOTER_STATUS` map,
a `ScribeFooter`) — those were moved into the pinned slot rather than duplicated. The
`consultation-review` footer carries the clinical finding the screen exists to expose
(*N of M claims could not be traced to the transcript*), shared across all four branches so the
frame does not shift between states. `workflow-studio-screen` was **skipped deliberately**: its
real frame and status bar live in `workflow-studio-editor.tsx`, and the three frames remaining in
the file (create form, error, loading) have no count, connection state or last-updated — an empty
bar would be worse than none. Documented in the file header.

Two footers deliberately avoid repeating in-content text (the DNA footer states the phase rather
than the SSE percentage the pane already renders; the LLM footer drops `end` because
`RequestSummaryStrip` carries provider/model/task) — otherwise the polite live region
double-announces.

**Rule-10 fixes:** `changelog-entry-drawer` and `test-run-panel` replaced bare `Loading…` text with
`<Skeleton>` compositions mirroring the loaded shape.

Also fixed in passing: `consultation-demo-screen` **had no `h1` at all** (rule 11 §6); the
`ScreenTemplate` header now supplies one.

### Files touched (by category, per the original implementation pass)

- `apps/admin-console/src/features/playground-*/components/*-screen.tsx` — `ScreenTemplate` adoption
- `apps/admin-console/src/features/workbench/**` — `ScreenTemplate` adoption
- `apps/admin-console/src/features/consultation-review/**`, `dna-writing-style/**`, `llm/**` (playground) — `StatusFooter` relocation/addition
- `apps/admin-console/src/features/changelog/components/changelog-entry-drawer.tsx`,
  `apps/admin-console/src/features/harness-ops/components/test-run-panel.tsx` — rule-10 skeleton fixes
- `apps/admin-console/src/app/(auth)/verify-email/*`, `reset-password/*` — exemption comments only, no frame change

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

All four gates green. `ScreenTemplate` and `StatusFooter` adoption confirmed present in the tree
(66 and 61 files respectively, console-wide) via `grep -rl` against `src/features` and `src/app`;
the `no-restricted-imports` structural guard for the sibling `DetailDrawer` ticket (TASK-769) is
unrelated to this scope and was not touched here.

No pre-existing test was modified and no axe assertion was relaxed as part of this re-verification
pass — the suite was run as committed.

## Not in scope / follow-ups

Shared with TASK-775 (see that ticket) — none specific to page-frame conformance beyond what is
recorded above.

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | **Split out of TASK-769 and renumbered 770 → 774.** The combined `TASK-769 · 770 · 771` document bundled this workstream ("770": page-frame conformance) with two unrelated numbers. A concurrent session had already committed a real, already-Completed `TASK-770-Dev-Bootstrap-Completeness` against the same number (and `TASK-771-Rate-Limit-Admin-Writes-404` against "771"), so both numbers were double-booked — the second such collision on this workstream (the first: 766/767/768 → 769/770/771, recorded in TASK-769's own history). Owner decision: split into standalone `TASK-774` (this ticket, page-frame conformance) and `TASK-775` (table conformance); confirmed both numbers free in `docs/implementation/` and `docs/archive/` before creating this document. Content migrated verbatim from the combined ticket's "770" section; no new page-frame work was performed as part of the split — this is a documentation move plus re-verification. |
| 2026-08-19 | Re-verified against the `wt/task-774` worktree: `ScreenTemplate`/`StatusFooter` presence spot-checked with `grep`, then `pnpm --filter @arcaai/admin-console test lint typecheck build` run clean (206/206 files, 1620/1620 tests, 0 lint warnings, clean typecheck, successful build). Status → Review. |
