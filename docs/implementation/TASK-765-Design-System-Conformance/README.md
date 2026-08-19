# TASK-765 — Design-System Conformance

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | refactor |
| **Branch** | `feat/loop` |
| **Opened** | 2026-08-18 |
| **Surfaces** | `packages/ui`, `apps/admin-console` |
| **Related** | Review artifact: *Calm Clinical Teal Audit* |

## Requirement Analysis

A design-archaeology teardown of a comparable product console (`Indus by Sarvam`, investigation
folder `design-systems/investigations/sarvam-studio`) was reviewed for transferable practice. Its
method — grade every token by evidence, keep a register of departures from your own system, and
record what you could not observe — was then applied to HOPE's own UI package and admin console.

The audit found HOPE ahead of the reference on four counts (single token namespace, tertiary-text
contrast, tab state legibility, active-nav legibility) and behind on six. This ticket fixes the
mechanically-fixable subset. Two findings are deliberately deferred (see *Not in scope*).

**Acceptance criteria**

- AC-1 Every focusable primitive in `packages/ui` carries one focus construction that clears
  WCAG 2.2 **1.4.11** (3:1 non-text contrast) in BOTH themes.
- AC-2 A focus indicator survives `forced-colors: active` (Windows High Contrast).
- AC-3 Reduced motion is honoured at the TOKEN layer, so a component authored after this ticket
  is covered without its author doing anything.
- AC-4 No CSS declaration in either surface is silently discarded by the browser.
- AC-5 Motion, elevation, stacking and the small-text floor are tokens, not literals at call sites.
- AC-6 All existing tests, lint, typecheck and builds stay green — 673 in `@arcaai/ui`,
  73 axe suites in `@arcaai/admin-console`.

## Current State Evaluation

Measured 2026-08-18 against `feat/loop`. Contrast computed from resolved token values (WCAG 2.x
relative luminance); counts from static analysis.

| ID | Finding | Measured | Rule |
|---|---|---|---|
| HOPE-01 | `ring-ring/50` is the ONLY focus signal on Button `default`/`secondary`/`ghost`/`destructive`/`link`, Toggle and the Accordion trigger — the paired `focus-visible:border-ring` needs a border-width those base classes do not have | **2.06:1** light · **2.67:1** dark (needs 3:1; full opacity gives 4.89:1 / 7.10:1) | WCAG 1.4.11, 2.4.13 |
| HOPE-02 | `outline-none` hard-removes the outline; Tailwind v4 draws `ring-*` as `box-shadow`, which forced-colors mode does not render → **no focus indicator at all in High Contrast** | 21 in `shadcn/` vs 29 already correct on `outline-hidden`; 107 repo-wide; 0 `forced-colors` blocks | WCAG 1.4.11 |
| HOPE-03 | Six different focus constructions across 20 primitives, incl. `sidebar`/`slider` rings with no colour falling through to `currentColor` | 6 variants | consistency |
| HOPE-05 | No motion token layer; `ease-[var(--cubic-ease-in-out)]` × 6 references a variable **defined nowhere in the repo** — invalid, silently ignored | 10 distinct durations, 6 hand-rolled beziers | — |
| HOPE-07 | Reduced motion chased per-component; `Skeleton`'s `animate-pulse` (19 uses) ungated | 87 bare `animate-*` vs 30 `motion-safe:` | WCAG 2.3.3 |
| HOPE-08 | 5 × `hsl(var(--token))` where the tokens are HEX → invalid colour, whole declaration discarded. One is `shadcn/sidebar.tsx:387`, the sidebar rail's border and hover — core chrome missing a border it believes it has | 5 sites | — |
| HOPE-09 | No stacking scale | `z-0 / z-[1] / z-10 / z-20 / z-30 / z-40 / z-50` ad hoc | — |
| HOPE-12 | Console reads at 12px and goes below it with arbitrary values | 58 × `text-[10px]` across 28 files, 8 × `text-[11px]` | WCAG 1.4.4 risk |
| HOPE-13 | No declared elevation strategy; `shadow-[0_4px_16px_rgba(0,0,0,0.2)]` is a hardcoded black invisible on the `#0c1418` dark canvas | 7 shadow steps + 4 arbitrary | — |

### What was found CORRECT and must not be undone

- **One token namespace.** The reference's worst structural defect (a stale shadcn HSL namespace
  still painting the canvas beneath a newer system) has no equivalent here. The `data-accent`
  layering, with its comment explaining the specificity ordering, is correct.
- **Contrast reasoning recorded at the token** — `--info` is indigo-300 not indigo-400, with the
  measurement (`4.47:1, just under`) written beside it.
- **The fixed code-editor surface**, deliberately excluded from `.dark` with its reason stated.
- **`muted-foreground`** at 5.43:1 light / 7.23:1 dark, where the reference product fails at 2.85:1.
- **Tabs and active-nav** each carry two state signals, not one.

## Implementation Plan

Executed as one authored foundation pass followed by three parallel sweeps with strict,
non-overlapping file ownership. `globals.css` is the write target for every token scale, so it
gets a single author; the sweeps only consume what it declares.

| Phase | Owner | Scope |
|---|---|---|
| **A · foundation** | orchestrator | `packages/ui/src/styles/globals.css` — motion, elevation, stacking and small-text scales + the root reduced-motion block |
| **B-A · primitives** | agent | `packages/ui/src/components/shadcn/**` — focus canon, `sidebar.tsx` invalid colour, motion/z literals |
| **B-B · library** | agent | `packages/ui/src/components/**` minus `shadcn/` — dead `--cubic-ease-in-out`, 4 registry invalid colours, motion/shadow literals |
| **B-C · console** | agent | `apps/admin-console/src/**` — small-text floor, stacking, motion/shadow literals |

Verified disjoint before fan-out. `api-key-usage-sheet.tsx` was the one file appearing in two
candidate scopes; since the sheet migration is deferred, it belongs wholly to B-C.

### Phase A — landed and verified

Added to `packages/ui/src/styles/globals.css`:

- `--motion-duration-instant|fast|normal|slow|reveal|slower` = 80/120/200/240/320/400ms on `:root`,
  surfaced as `@utility duration-*`. Tailwind v4 has an `--ease-*` theme namespace but **no
  `--duration-*` one**, so theme keys alone generate nothing — this was caught by compiling the
  real admin-console bundle and grepping for the emitted class.
- `--ease-emphasized` (overlay entrance) and `--ease-spring` (overshoots; reserved for confirmation
  moments) via `@theme inline`.
- `--elevation-raised` / `--elevation-overlay` on `:root` with **separate dark values** — dark is
  tonal-first and needs a deeper, more diffuse shadow, because a black shadow on a near-black
  canvas is invisible. Surfaced as `shadow-flat|raised|overlay`.
- `@utility z-base|raised|sticky|chrome|overlay|toast` = 0/10/20/40/50/60.
- `--text-2xs: 0.6875rem` / 1rem line-height — one declared step below `text-xs`, and the floor.
- A root `@media (prefers-reduced-motion: reduce)` block that rewrites every duration token to `0s`
  and clamps animation/transition duration globally, **with an exception keeping spinners at 1.6s**
  — an indicator that stops reads as "hung", so meaningful motion is slowed rather than removed.
  This is the reference investigation's single strongest practice (its BP-01), adopted verbatim in
  mechanism: neutralising the tokens covers every consumer at once, including components authored
  later, which per-component `motion-safe:` prefixes can never promise.

**Phase A verification (actual output):**

- `pnpm --filter @arcaai/ui test` → `Test Files 243 passed (243) · Tests 673 passed (673)`
- `pnpm --filter @arcaai/admin-console build` → `✓ Compiled successfully`, full route table emitted
- Emitted bundle greps confirm the utilities resolve:
  `.text-2xs{font-size:.6875rem;line-height:var(--tw-leading,1rem)}` ·
  `.duration-fast{transition-duration:var(--motion-duration-fast)}` ·
  `.shadow-raised{--tw-shadow:var(--elevation-raised);…}` · `.z-chrome{z-index:40}` ·
  `.ease-spring{--tw-ease:cubic-bezier(.34, 1.42, .5, 1);…}` ·
  `--motion-duration-fast:0s` under `prefers-reduced-motion` ·
  `[data-slot=spinner],.animate-spin{animation-duration:1.6s!important;…}`

## Not in scope (deferred, with reasons)

| Deferred | Why |
|---|---|
| **HOPE-14** — 8 hand-rolled `SheetContent` panels bypassing `DetailDrawer` (audit-logs, rbac, harness-ops, ai-models, api-keys, storage, consultations, queues), plus the ESLint rule banning `SheetContent` outside `shared/detail/` | Real refactoring with test churn across 8 feature modules, unlike the mechanical sweeps here. Deserves its own reviewable diff once the token foundation is proven. |
| **HOPE-11** — ~300 lines of magicui keyframes (`meteor`, `aurora`, `orbit`, `rainbow`, `marquee` ×6) and the `--color-1…5` rainbow ramp living inside the canonical token file | Needs quiet in `globals.css`, which three concurrent agents are consuming. Moving them to `styles/decorative.css` also touches package exports. Separate ticket. |
| **HOPE-16** — 53 routes in one `collapsible="icon"` sidebar; collapsed, that is 53 unlabelled icons | An IA decision, not a conformance fix. Worth designing before the route count grows again. |
| Blanket sweep of the stock `shadow-sm`/`shadow-md`/… steps onto the three new elevation roles | A design decision about which surfaces are raised, not a mechanical substitution. |

## Implementation Summary

### Phase A — token foundation (`packages/ui/src/styles/globals.css`)

As planned, plus one correction found during execution.

**Defect in the first cut of Phase A, caught by two sweep agents independently.** The
`@utility duration-*` rules initially set `transition-duration` only. `tw-animate-css` defines
`--animate-in: enter var(--tw-animation-duration, var(--tw-duration, .15s)) …`, so
`animate-in`/`animate-out` read **`--tw-duration`** — which Tailwind's NUMERIC duration utilities
set but a bare `transition-duration` rule does not. Putting a named duration on an animated
element would have silently collapsed it to the library's 0.15s fallback. Both agents hit this,
both correctly refused to sweep durations rather than shipping a silent regression, and both
proposed the same remedy. Each utility now sets both properties. Confirmed in the shipped bundle:
`.duration-normal{transition-duration:var(--motion-duration-normal);--tw-duration:var(--motion-duration-normal)}`.

This is worth recording because it is the same failure mode the audit was about: a token that
*looks* declared but does not reach its consumer.

### Phase B-A — primitives (32 files + 1 new test)

| Change | Before → after |
|---|---|
| `ring-ring/50` in `shadcn/` | 21 → **0** |
| `outline-none` in `shadcn/` | 21 → **0** |
| `outline-hidden` in `shadcn/` | 27 → **51** |
| `hsl(var(--` in `shadcn/` | 1 → **0** |
| literal `z-50` | 20 → **0** (→ `z-overlay`) |

- **`button.tsx` `focus-visible:border-ring`**: moved from the base into the `outline` variant
  rather than dropped or backed with a transparent base border. Adding a base border would shift
  label/icon metrics across all six variants to make a *second, redundant* indicator work;
  dropping it would silently regress `outline`, the one variant that does declare `border`.
  Moving it preserves rendered behaviour exactly while removing the inert class from the other five.
- **Beyond the brief, correctly**: `button`/`badge` destructive variants carried
  `focus-visible:ring-destructive/20 dark:…/40` — a genuine focus indicator at 20–40% opacity,
  *worse* than the `ring-ring/50` case, and tailwind-merge drops the base `ring-ring` in its
  favour. De-alpha'd. The `aria-invalid:` error tints were left untouched as instructed.
- **`sidebar.tsx` correction to the brief**: its rings already carried `ring-sidebar-ring`
  (not `currentColor` as I had stated); `--sidebar-ring` is defined identically to `--ring` across
  the base theme and all six accent blocks, so it was kept for correct sidebar scoping and only
  the width normalised.
- New `shadcn/__tests__/focus-canon.vitest.ts` — 8 source-text assertions over all 57 primitives
  (no `ring-ring/50`, no alpha'd focus ring, no `outline-none`, every ring width paired with a
  colour token, no `hsl(var(--`, no literal `z-50`). This is the regression guard that stops the
  canon drifting back, modelled on the existing `styles/__tests__/accent-tokens.vitest.ts`.

### Phase B-B — component library (36 files)

| Change | Before → after |
|---|---|
| `ease-[var(--cubic-ease-in-out)]` (dead variable) | 6 → **0** |
| `hsl(var(--` | 4 → **0** |
| `ease-[cubic-bezier(…)]` | 20 → **5** |
| arbitrary `shadow-[` | 18 → **12** |
| `text-[10px]`/`[11px]` | 48 → **0** |

Left deliberately: 4 saturated zero-offset colour glows in `einui` glass components (an accent
effect, not elevation — `shadow-raised` would destroy the glassmorphism intent); 5 ×
`cubic-bezier(0.4,0.36,0,1)` in vendored billingsdk pricing tables (genuinely distinct control
points, not near `ease-emphasized`); `manifest/product-list.tsx`'s `shadow-[0_0_0_1px]` (already
the correct ring idiom); and `tool-ui/image-gallery/styles.css` (raw `::view-transition` CSS with
its own reduced-motion block — a `var()` there would silently fall back if consumed without
`globals.css`).

**29 vendored `registries/**` files were modified** and will need re-applying on upstream sync:
`tool-ui` (12), `manifest` (7), `einui` (5), `billingsdk` (2), `diceui` (1), `mapcn` (1),
`prompt-kit` (1).

### Phase B-C — admin console (33 files)

| Change | Before → after |
|---|---|
| `text-[10px]` | 58 (28 files) → **0** |
| `text-[11px]` | 8 (4 files) → **0** |
| `text-2xs` | 0 → **66** |
| numeric `z-<n>` | 3 → **0** |

- `app/(console)/layout.tsx` `z-40` → `z-chrome`; `rbac/permission-matrix.tsx` ×2 `z-10` →
  `z-sticky` (sticky header cells inside an `overflow-x-auto` container — 20 is the honest layer).
- **No layout fix was required by the 10px → 11px change**, and the reason is structural rather
  than lucky: `text-[10px]` carries no line-height of its own, so it inherited 16px — exactly what
  `--text-2xs--line-height` declares. Vertical metrics are unchanged at all 58 sites; only the
  glyph size moves.
- Corroborating evidence the 11px step was the right floor: four feature modules had already
  reached for `text-[11px]` independently before it had a token.
- Left alone: `scribe/consultations-column.tsx`'s `shadow-[inset_2px_0_0_var(--primary)]` — an
  *inset* 2px accent rail marking the selected row, not elevation; the outer elevation tokens
  would delete the affordance.

### Two corrections to this ticket's own baseline

Both raised by the sweep agents and verified:

1. The counts I recorded for numeric `duration-<n>`, `ease-[cubic-bezier(…)]` and arbitrary `z-[`
   were measured across `packages/ui` **and** `apps/admin-console` combined, then quoted at the
   console agent as if they were console-local. Re-measured: the console has **0** of each; all
   197 numeric durations are in `packages/ui`. No work was missed — the console brief simply
   contained two near-empty sections.
2. "73 axe test files" over-counted: it matched setup and type-declaration files. Measured by
   content, the console has **49** axe-using test files. All pass.

## Verification (combined, run by the orchestrator after all three sweeps)

```
pnpm --filter @arcaai/ui test          Test Files  244 passed (244)   Tests   681 passed (681)
pnpm --filter @arcaai/ui lint          eslint src --max-warnings 0    (clean)
pnpm --filter @arcaai/ui typecheck     tsc --noEmit                   (clean)
pnpm --filter @arcaai/admin-console test   Test Files  202 passed (202)   Tests  1590 passed (1590)
pnpm --filter @arcaai/admin-console build  ✓ Compiled successfully
```

`@arcaai/ui` went 673 → 681 tests (+8 from the new focus-canon guard); no pre-existing test was
modified. The console's 5 failing suites reported mid-sweep (`ai-task-defaults/*`,
`harness-policy/*`) were proved pre-existing by stash-and-re-run at the time, and have since been
resolved by the concurrent workstream described below — the console now runs fully green.

### Acceptance criteria

| AC | Status |
|---|---|
| AC-1 focus ≥ 3:1 both themes | **Met in `shadcn/`** — `ring-ring/50` → `ring-ring`, 2.06:1 → 4.89:1 light, 2.67:1 → 7.10:1 dark. **Not met in two vendored registries** — see Remaining. |
| AC-2 focus survives `forced-colors` | **Met** — all 21 `outline-none` in `shadcn/` → `outline-hidden` (51 total) |
| AC-3 reduced motion at the token layer | **Met** — one root block; `--motion-duration-fast:0s` confirmed in the shipped bundle, spinners held at 1.6s |
| AC-4 no silently-discarded declarations | **Met** — `hsl(var(--` 5 → 0; `--cubic-ease-in-out` 6 → 0 |
| AC-5 motion/elevation/stacking/type as tokens | **Partly** — type floor and stacking done (117 `text-2xs`, 0 numeric console z); durations deferred, see Remaining |
| AC-6 gates stay green | **Met** — see above |

## Remaining after this ticket

| Item | Detail |
|---|---|
| **19 × `ring-ring/50` in vendored registries** | `registries/basecn/*` (9) and `registries/diceui/*` (5+). Outside both sweep agents' scopes. **Latent, not shipping**: zero `apps/admin-console` imports of either registry. They ARE on the `@arcaai/ui` barrel, so a future consumer would inherit the 2.06:1 ring. Fix before either registry is used. |
| **184 numeric `duration-<n>` in `packages/ui`** | Now mechanically safe to sweep since `--tw-duration` is set, but the mapping is lossy for 700/1000/45/90 (no near token) and approximate for 300→320, 150→120. Needs a value-by-value decision, not a substitution. 40 of the 184 sit on `animate-*` elements. |
| **HOPE-14 / HOPE-11 / HOPE-16** | Deferred as recorded above — sheet migration, decorative-keyframe split, nav IA. |

## Note: concurrent workstream in the same working tree

While these sweeps ran, an unrelated workstream landed uncommitted changes in this tree — an SDK
family version bump (`2.0.7 → 3.0.0` across `room`, `stt`, `vad`, `med-ner`, `noise-filter`,
`agentic-sdk-v2`, `vox-node`) and `INTERNAL_ACCESS_TOKEN` work carrying *"owner decision D-D,
2026-08-17"* (`scripts/__tests__/env-sync.test.ts`, `settings-registry/__tests__/fail-mode.governance.test.ts`,
`apps/api/src/bootstrap/__tests__/business-plane-apikey-exemptions.test.ts`).

**These 12 files are NOT part of TASK-765 and must not be committed with it.** One of them
(`business-plane-apikey-exemptions.test.ts`) was briefly reverted by the orchestrator on the
mistaken assumption it was a sweep agent's scope escape; it has been restored and verified
(28/28 passing). Stage this ticket by path, not with `git add -A`.

## Change History

| Date | Change |
|---|---|
| 2026-08-18 | Ticket opened. Audit findings recorded; Phase A token foundation landed and verified against a real admin-console build. Phases B-A/B-B/B-C dispatched in parallel. |
| 2026-08-18 | Phase A corrected: `@utility duration-*` now also sets `--tw-duration`, without which a named duration on any `animate-in`/`animate-out` element silently collapsed to `tw-animate-css`'s 0.15s fallback. Found independently by two sweep agents. |
| 2026-08-18 | All three sweeps complete. Combined verification green: `@arcaai/ui` 681/681, `@arcaai/admin-console` 1590/1590 + build. Baseline corrections recorded; 19 vendored-registry focus rings and the 184 numeric durations carried forward as known remaining work. Status → Review. |
| 2026-08-19 | Spot-check of the described changes against `feat/loop`: `globals.css` tokens (`--motion-duration-*`, `--elevation-raised`, `@utility z-chrome`, `--text-2xs`, the `prefers-reduced-motion` block) exist as described; `packages/ui/src/components/shadcn/__tests__/focus-canon.vitest.ts` exists; no `.tsx` file in `shadcn/` still carries `ring-ring/50`, `outline-none`, or `hsl(var(--`; `z-chrome`/`z-sticky` are used in `apps/admin-console/src/app/(console)/layout.tsx` and `.../features/rbac/components/permission-matrix.tsx` as claimed. However, commit `06b617609` (`refactor(TASK-765,TASK-766): design-system conformance…`) — the commit that actually landed this ticket's work — directly **violates this README's own instruction** ("These 12 files are NOT part of TASK-765 and must not be committed with it"): it includes `scripts/__tests__/env-sync.test.ts`, `packages/vox-node/src/core/transport.ts`, `packages/agentic-sdk-v2/**`, and several package-version bumps in the same commit. The commit message states the work was authored in a parallel session and committed by someone else ("the analysis and implementation are not mine") and separately documents an unresolved TASK-766 ticket-number collision with an unrelated ticket. **Status kept at Review**: the boundary violation is commit hygiene in what shipped, not incomplete scope — the token/sweep work checks out on file-level inspection and the suites are green. Recorded here so the owner can reconcile the commit contents and the TASK-766 numbering collision at sign-off; the ticket's "clean, isolated diff" claim does not hold. |
