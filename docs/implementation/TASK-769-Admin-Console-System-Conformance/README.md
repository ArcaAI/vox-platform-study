# TASK-769 · 770 · 771 — Admin-Console System Conformance

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | refactor |
| **Branch** | `feat/loop` |
| **Opened** | 2026-08-19 |
| **Surface** | `apps/admin-console`, plus one shared ESLint preset |
| **Follows** | [TASK-765](../TASK-765-Design-System-Conformance/README.md) (token foundation) |

## Requirement Analysis

Apply the HOPE design system consistently across the admin console, following the TASK-765 token
work. Split into three sub-tickets by the kind of drift, each with disjoint file ownership:

| Ticket | Scope |
|---|---|
| **769** | 8 feature modules hand-rolling a detail `Sheet` instead of `DetailDrawer` |
| **770** | 8 screens without `ScreenTemplate`, 12 without `StatusFooter`, 2 rule-10 loading violations |
| **771** | 10 table surfaces measured against the rule-11 table contract |

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

**Conclusion: there was no sweep to do.** The real drift was three specific structural gaps, which
became 769/770/771. Recording this because the instinct to run a broad codemod here would have
produced churn without conformance.

## Implementation Summary

### TASK-769 — 8 hand-rolled sheets → `DetailDrawer`

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

### TASK-770 — page-frame conformance

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
- `knowledge-documents-screen` — an audit false positive on my part. The file is a bare
  `WorkingTenantGate` wrapper; the real frame (`ScreenTemplate contentMode="fill"` + `StatusFooter`
  around a `VirtualizedDataGrid`) already exists one level down in `knowledge-documents-list.tsx`.
  Adding a template here would nest two frames and two scroll containers.

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

### TASK-771 — table conformance: audit first, migrate second

**Migrated to `AdminDataGrid`: none — and that is the correct outcome.**

8 of 10 are not record lists: permission matrices, checkbox grids, fixed comparison tables and
key/value summaries iterating compile-time constants. A virtualized server-driven grid would be
actively worse for every one of them.

The 2 that genuinely *are* record lists (`tools-mcp-screen`, `gate-queue-panel`) are **blocked by
the backend contract, not by preference**: `AdminDataGrid` hardcodes
`manual={{ sorting: true, filtering: true, pagination: true }}`
([admin-data-grid.tsx:194](../../../apps/admin-console/src/shared/data/admin-data-grid.tsx)) and is
strictly server-driven, while `getGateQueue()` and `listMcpServers()` take **no parameters** and
`GET /admin/mcp-servers` accepts only `?tenantId=`. Wiring the grid over a paramless endpoint would
ship sort and pager controls that silently do nothing. Verified independently against all three
sources.

All ten were brought up to the rule-11 table contract in place. Real defects found and fixed:

1. **`pipeline-policy-screen` was mouse-only** (WCAG 2.1.1) — a `<TableRow onClick>` was the sole
   path to the scope editor, with no keyboard route at all. Now a real `<button>` with
   `aria-pressed`; the row click stays as a pointer affordance.
2. **4 raw `<table>` scroll containers were not keyboard-reachable** (axe
   `scrollable-region-focusable`) — bare `overflow-x-auto` divs, now `tabIndex={0}` +
   `role="region"` + label, per the `DetailDrawer` precedent.
3. Two unnamed tables given names; 25 missing `scope="col"`; one nested scroll area removed
   (rule 11 §1, one scroll container per panel).

**Corrected two of the ticket's own assumptions:** `permission-matrix` was already exemplary
(caption, both-axis scopes, `sr-only` text on every glyph so nothing rides on colour); and the
shadcn `Table` primitive already ships `tabIndex={0}` on its scroll container, so 6 of the 10 were
compliant before this ticket. All ten skeletons and every reachable empty state were already
correct — none were added.

## Verification (combined, run by the orchestrator after all three)

```
pnpm --filter @arcaai/admin-console test        Test Files  205 passed (205)   Tests  1610 passed (1610)
pnpm --filter @arcaai/admin-console lint        eslint src --max-warnings 0    (clean)
pnpm --filter @arcaai/admin-console typecheck   tsc --noEmit                   (clean)
pnpm --filter @arcaai/admin-console build       ✓ Compiled successfully
pnpm --filter @arcaai/ui test                   Test Files  244 passed (244)   Tests   681 passed (681)
```

Baseline was 202 files / 1590 tests → **205 / 1610** (+3 files, +20 tests, all new coverage). No
pre-existing test was modified and no axe assertion was relaxed. `@arcaai/ui` unchanged at 681,
confirming TASK-765 did not regress.

**Cross-agent damage check (the real risk this round).** One agent ran `prettier --write` over
whole component directories, rewriting 12 files it did not own; it detected and reverted all 12
(10 by `git checkout HEAD --`, 2 by 3-way merge because they carried another agent's live table
work). Independently verified afterwards that the merge was clean: every TASK-771 a11y fix in the
two contested files survives (`sr-only` caption, `tabIndex`/`role="region"`, `scope="col"` ×3,
table `aria-label`, outer scroll wrapper still removed), as does all of TASK-765
(66 × `text-2xs`, 0 regressions to `text-[10px]`, `z-chrome`, `z-sticky`).

**Note for future parallel work: do not run prettier over a directory in this repo.** It is not
uniformly prettier-formatted (~29 files differ at HEAD) and prettier is *not* in the lint gate
(`lint` is `eslint src --max-warnings 0` only), so a directory-wide format rewrites unrelated files.

## Not in scope / follow-ups

| Item | Detail |
|---|---|
| **`AdminDataGrid` has no client-driven mode** | `manual` is hardcoded on. Migrating `tools-mcp-screen` or `gate-queue-panel` requires gateway list params (`apps/api/src/modules/mcp-admin/`), the feature api clients, and the grid change landed **together** — that pairing is the unit of work, and it spans `apps/api`. |
| **19 × `ring-ring/50` in vendored registries** | Carried from TASK-765. `registries/basecn/*`, `registries/diceui/*` — latent (zero console imports) but on the `@arcaai/ui` barrel. |
| **184 numeric `duration-<n>` in `packages/ui`** | Safe to sweep since TASK-765 added `--tw-duration`, but lossy for 700/1000/45/90. Needs decisions, not substitution. |
| **HOPE-11 / HOPE-16** | Decorative-keyframe split out of `globals.css`; 53-route single-tier nav IA. |

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
