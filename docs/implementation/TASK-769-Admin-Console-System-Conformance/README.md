# TASK-769 — Admin-Console Detail-Surface Conformance

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | refactor |
| **Branch** | `feat/loop` |
| **Opened** | 2026-08-19 |
| **Surface** | `apps/admin-console`, plus one shared ESLint preset |
| **Follows** | [TASK-765](../TASK-765-Design-System-Conformance/README.md) (token foundation) |
| **Related (split out 2026-08-19)** | [TASK-774](../TASK-774-Page-Frame-Conformance/README.md) (page-frame conformance), [TASK-775](../TASK-775-Table-Conformance/README.md) (table conformance) |

## Requirement Analysis

Apply the HOPE design system consistently across the admin console, following the TASK-765 token
work. This ticket's scope is the 8 feature modules that hand-roll a detail `Sheet` instead of
using the console-wide `DetailDrawer` (`.claude/rules/11-ux-ui-principles.md` §1 "Detail Surface").

This document originally also carried two other sub-tickets ("770" page-frame conformance, "771"
table conformance) under a combined `TASK-769 · 770 · 771` title. Both were split out on
2026-08-19 after a second numbering collision (see Change History) — they now live at
**[TASK-774-Page-Frame-Conformance](../TASK-774-Page-Frame-Conformance/README.md)** and
**[TASK-775-Table-Conformance](../TASK-775-Table-Conformance/README.md)**. This document keeps only
the DetailDrawer migration, which is TASK-769's own scope.

## Current State Evaluation

**Measured before starting — and the measurement changed the plan.** The premise "apply the system
everywhere" implied broad non-conformance. It is not there:

| Rule | Measured | Verdict |
|---|---|---|
| 10 — `<Skeleton>` for loading | 194 files | conformant |
| 10 — `<Spinner>` not hand-rolled | 118 `<Spinner>` vs **1** bare `animate-spin` (a running-node status icon, legitimate) | conformant |
| 11 §4 — `Empty` family | 104 files | conformant |
| 11 §5 — toast feedback | 422 `toast.success/error` | conformant |
| 11 §10 — semantic tokens only | **0** hex/rgb/hsl literals in `className` | conformant |
| — elevation | 6 total shadow uses | nothing to sweep; the gap is in `packages/ui` |
| — motion | **0** numeric `duration-<n>`, 0 `ease-[cubic-bezier(…)]` | nothing to sweep |

The 4 `animate-pulse` hits are live-status indicators (recording dot, streaming caret), not
skeletons — and are now covered by TASK-765's token-layer reduced-motion block regardless.

**Conclusion: there was no broad sweep to do.** The real drift in the console was three specific
structural gaps (detail sheets, page frames, tables), which became three separate tickets. This
document covers the first — detail sheets → `DetailDrawer`.

## Implementation Summary

### 8 hand-rolled sheets → `DetailDrawer`

All 8 migrated; `SheetContent` under `src/features/**` is now **0**. Widths preserved on 7;
`api-key-usage-sheet` widened from `sm:max-w-md` to the drawer's narrowest size (`md`) as a
deliberate consistency-over-bespoke-width call. Mobile improves everywhere — the drawer's
full-screen-below-`md` contract replaces ad-hoc `sm:` caps.

`consultation-detail-panel.tsx` was flagged as a possible exemption on its name; it was checked
and **disqualified** — a `Sheet` + `SheetContent side="right"` opened by row click is an overlay
detail surface, not an inline panel.

**Guard added.** `no-restricted-imports` scoped to `src/features/**` (ignoring
`src/shared/detail/**`) in `packages/config-eslint/flat/next.js`, banning `SheetContent` with a
message pointing at `DetailDrawer` and the rule. Because `no-restricted-imports` **replaces**
rather than merges per file group, the pre-existing unscoped-Prisma path *and* pattern were
hoisted into consts and re-declared in the scoped block — verified by probe that both restrictions
fire in `features/` and that `shared/detail/` stays exempt.

> **Behaviour change, reviewed and KEPT — see the review below.** Both form sheets (`policy-form-sheet`,
> `model-form-sheet`) now show a *"Discard unsaved changes?"* confirmation when closed with
> pending edits. Neither had any such dialog at HEAD. The old `key={id}-{updatedAt}` remount
> discarded state implicitly; lifting state into the drawer removed that, and a `reset()` on close
> would have matched the old behaviour exactly. The safer path was taken instead
> (rule 11 §5, "destructive actions require confirmation").
>
> **Review outcome (2026-08-19): keep it.** Measured against the Sarvam teardown's EX-09/P3, the
> anti-pattern there is *"no exit exists in the DOM — Escape ignored, scrim click ignored, no close
> button"*, whose prescribed remediation is *"Escape, an explicit close control, and an
> outside-click target"*. All three are present here and all three still close the drawer; they
> confirm first, and only when `isDirty`. The `ConfirmDialog` is itself freely dismissible. The
> confirmation also satisfies WCAG 2.2 **3.3.7 Redundant Entry**, which rule 11 names explicitly
> ("never re-ask for data already entered in a flow") — silently discarding a half-filled policy
> form is exactly that failure, so reverting would trade a passing criterion for a regression.

Latent bug found in passing: `bucket-browser-sheet` rendered its `SheetHeader` *inside* a
conditional body, so with a null bucket the sheet had no `SheetTitle`. Never triggered in practice;
now structurally impossible.

### Follow-on fix — silent close-blocking (found by the discard review)

Reviewing the confirmation surfaced a genuine violation beside it. Both form sheets guarded close
with a bare `if (isPending) return;`, so while a save was in flight Escape, overlay click and the
X button all no-opped **silently**: `SheetPrimitive.Close` renders unconditionally, stays
focusable, and `DetailDrawer` had no way to disable it — no `disabled`, no `aria-disabled`, no
visible reason. That is Sarvam **EX-11** almost verbatim (*"cursor: pointer, tabindex=0, no
disabled, no aria-disabled … a control that looks and focuses like a control must do something"*),
WCAG **4.1.2** name/role/**value**, and EX-09 in miniature — for the duration of a hung request
the drawer had no exit at all.

Fixed by making the block **declared rather than implicit**: `DetailDrawer` gained
`closeBlockedReason?: string`. When set, it renders a properly `disabled` + `aria-disabled` close
control whose accessible name carries the reason, and suppresses Escape and outside-click the same
way, so all three exits agree with one another instead of two failing silently while the third
looks operable. Both form sheets pass `isPending ? 'Saving the … — wait for it to finish.' : undefined`
(rule 11 §5, "disabled buttons need a visible reason").

`IconX` from `@tabler/icons-react` — the console's own close glyph, 16 existing uses — was used
rather than adding `lucide-react`, which is not a dependency of this app.

Guarded by 4 new tests in `shared/detail/__tests__/detail-drawer.test.tsx`: control enabled and
Escape working when unblocked; `disabled` + `aria-disabled` + reason in the accessible name when
blocked; Escape suppressed identically when blocked; and axe clean while blocked.

## Verification

Combined verification (this ticket plus the two split-out siblings TASK-774/TASK-775 — all three
touch disjoint files in the same admin-console app and were verified together):

```
pnpm --filter @arcaai/admin-console test        Test Files  206 passed (206)   Tests  1620 passed (1620)
pnpm --filter @arcaai/admin-console lint        eslint src --max-warnings 0    (clean)
pnpm --filter @arcaai/admin-console typecheck   tsc --noEmit                   (clean)
pnpm --filter @arcaai/admin-console build       ✓ Compiled successfully
pnpm --filter @arcaai/ui test                   Test Files  244 passed (244)   Tests   681 passed (681)
```

Baseline was 202 files / 1590 tests → **205 / 1610** (+3 files, +20 tests, all new coverage) at
original close-out; re-run in the `wt/task-774` worktree on 2026-08-19 shows 206/1620 (a handful of
additional tests landed since via unrelated concurrent work in the same tree). No pre-existing test
was modified and no axe assertion was relaxed. `@arcaai/ui` unchanged at 681, confirming TASK-765
did not regress.

**Cross-agent damage check (the real risk this round).** One agent ran `prettier --write` over
whole component directories, rewriting 12 files it did not own; it detected and reverted all 12
(10 by `git checkout HEAD --`, 2 by 3-way merge because they carried another agent's live table
work). Independently verified afterwards that the merge was clean: every table a11y fix in the two
contested files survives (`sr-only` caption, `tabIndex`/`role="region"`, `scope="col"` ×3, table
`aria-label`, outer scroll wrapper still removed), as does all of TASK-765 (66 × `text-2xs`, 0
regressions to `text-[10px]`, `z-chrome`, `z-sticky`).

**Note for future parallel work: do not run prettier over a directory in this repo.** It is not
uniformly prettier-formatted (~29 files differ at HEAD) and prettier is *not* in the lint gate
(`lint` is `eslint src --max-warnings 0` only), so a directory-wide format rewrites unrelated files.

## Not in scope / follow-ups

| Item | Detail |
|---|---|
| **19 × `ring-ring/50` in vendored registries** | Carried from TASK-765. `registries/basecn/*`, `registries/diceui/*` — latent (zero console imports) but on the `@arcaai/ui` barrel. |
| **184 numeric `duration-<n>` in `packages/ui`** | Safe to sweep since TASK-765 added `--tw-duration`, but lossy for 700/1000/45/90. Needs decisions, not substitution. |
| **HOPE-11 / HOPE-16** | Decorative-keyframe split out of `globals.css`; 53-route single-tier nav IA. |

See [TASK-774](../TASK-774-Page-Frame-Conformance/README.md) and
[TASK-775](../TASK-775-Table-Conformance/README.md) for their own follow-ups.

## Note: concurrent workstream in the same tree

An unrelated, owner-requested workstream is uncommitted in this tree — SDK family version bump
(`2.0.7 → 3.0.0`), `INTERNAL_ACCESS_TOKEN`, and service-account scope work across `apps/api`,
`packages/applications`, `packages/{agentic-sdk-v2,vox-node,room,stt,vad,med-ner,noise-filter}`
and `scripts/`. **~15 files that are NOT part of these tickets.** Stage by path; do not `git add -A`.

## Change History

| Date | Change |
|---|---|
| 2026-08-19 | **Renumbered 766/767/768 → 769/770/771.** A concurrent session had already committed TASK-766 (Day-One Seed Completeness), TASK-767 (Standalone Feature Credentials) and TASK-768 (Downstream Unreachable Error Contract) against the same numbers; 764 was the highest when this work was scoped. Caught at commit time, before anything was written to history. |
| 2026-08-19 | Opened. Pre-measurement found the console already conformant on rules 10/11 — scope narrowed from a sweep to three structural migrations. 769/770/771 dispatched in parallel on disjoint file sets. |
| 2026-08-19 | Discard-confirmation reviewed against Sarvam EX-09/P3 and WCAG 3.3.7 — **kept**. Review surfaced a real EX-11/4.1.2 violation beside it (silent close-blocking while saving); fixed with a declared `closeBlockedReason` on `DetailDrawer` + 4 regression tests. |
| 2026-08-19 | All three complete. Combined verification green (205/1606 + build; `@arcaai/ui` 681 unchanged). Cross-agent prettier churn detected, reverted by its author, and independently re-verified. Status → Review. |
| 2026-08-19 | **Second collision, split out.** `TASK-770-Dev-Bootstrap-Completeness` and `TASK-771-Rate-Limit-Admin-Writes-404` turned out to be separate, unrelated, already-Completed tickets committed by another session against the same two numbers — the combined document's "770" (page-frame conformance) and "771" (table conformance) sections were double-booked a second time. Owner decision: renumber the two colliding workstreams to **TASK-774** and **TASK-775**, write them up as full standalone tickets, and trim this document back to its own scope (the DetailDrawer migration, TASK-769's original and only remaining content). Confirmed 774/775 free in both `docs/implementation/` and `docs/archive/` before creating the new documents. Re-verified `pnpm --filter @arcaai/admin-console test lint typecheck build` clean in the `wt/task-774` worktree (206/206 files, 1620/1620 tests) as part of the split. |
