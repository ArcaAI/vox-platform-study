# TASK-787 — Sarvam Tatva Identity Migration

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | refactor |
| **Branch** | TBD (branch off the current active branch — confirm with owner, do not assume `dev`) |
| **Opened** | 2026-08-22 |
| **Surfaces** | `packages/ui`, `apps/admin-console` |
| **Follows** | [TASK-765](../TASK-765-Design-System-Conformance/README.md) (token foundation), [TASK-769](../TASK-769-Admin-Console-System-Conformance/README.md), [TASK-774](../TASK-774-Page-Frame-Conformance/README.md), [TASK-775](../TASK-775-Table-Conformance/README.md) |
| **Reference** | `/Users/taphuynh/Desktop/lab/design-systems/investigations/sarvam-studio` (Sarvam "Indus" console; design system internally named **Tatva**) |

---

## Requirement Analysis

Replace HOPE's **Calm Clinical Teal** corporate identity with Sarvam Tatva's achromatic modern
style across `packages/ui` and `apps/admin-console`.

### Owner decisions already taken

| # | Decision | Date |
|---|---|---|
| **OD-1** | Adopt Tatva's **visual identity**, not merely its method. Calm Clinical Teal is retired. | 2026-08-22 |
| **OD-2** | Where Tatva's own investigation (`06-exceptions.md`) grades a value an anti-pattern and prescribes a fix, **use the fixed value**. Applies to EX-01 (focus ring) and EX-04 (tertiary text). | 2026-08-22 |
| **OD-3** | Do **not** reproduce Tatva's EX-13 two-namespace defect. HOPE keeps one token namespace. | 2026-08-22 |
| **OD-4** | **All design/Figma gates are skipped.** `12-design-workflow.md` gates 1–3 do not apply to this ticket. The written geometry contract (§Geometry Contract) replaces them. | 2026-08-22 |
| **OD-5** | Nav IA rework proceeds as its **own phase / separate ticket**, not folded into the token work. | 2026-08-22 |
| **OD-6** | All twelve judgement calls **J-1…J-12 resolved as recommended** (§Resolved Decisions). Binding — phase agents implement, they do not re-open. | 2026-08-22 |

### Relationship to TASK-765 — this ticket reverses a prior conclusion, deliberately

TASK-765 audited HOPE against this same reference and concluded HOPE was **ahead on four counts
and behind on six**, adopting Tatva's *method* and exactly one of its practices (BP-01, token-level
reduced motion) while explicitly keeping Calm Clinical Teal. **OD-1 supersedes that.** The audit's
findings are not withdrawn — they are the reason this migration can be done safely, because the
token layer TASK-765 built (motion, elevation, stacking, small-text scales, focus canon) is the
substrate the new values drop into.

### Acceptance criteria

- **AC-1** Every semantic token in `globals.css` resolves to a Tatva-derived value, verified against
  the emitted admin-console bundle — not against source.
- **AC-2** No text-carrying foreground/background pair falls below **4.5:1**; no UI/non-text pair
  below **3:1**, in **both** themes. Verified by computed ratio, not by eye.
- **AC-3** The two pre-existing HOPE contrast failures (`--input` 1.22:1, `--sidebar-accent` 1.08:1)
  are fixed, not carried forward.
- **AC-4** A contrast gate exists in CI that would have caught AC-2 failing. Today none does
  (see §Current State — The Gate Gap).
- **AC-5** Geometry matches the §Geometry Contract for every one of the 57 shadcn primitives.
- **AC-6** All gates green: `@arcaai/ui` and `@arcaai/admin-console` lint, typecheck, test, build.
- **AC-7** ✅ **Met 2026-08-22** — all twelve judgement calls resolved and recorded (§Resolved
  Decisions). Phase 3 is unblocked.

---

## Current State Evaluation

Measured 2026-08-22 against `dev-2.2`. Two read-only agents; counts from static analysis, contrast
computed from resolved token values via the WCAG 2.x relative-luminance formula.

### HOPE today

| Aspect | State |
|---|---|
| Token source | ONE canonical file, `packages/ui/src/styles/globals.css` (833 lines). `apps/admin-console/src/app/globals.css` is 13 lines and only re-points `--font-sans` at the `next/font` Inter variable. |
| Structure | raw ramp (`--teal-500`) → semantic role (`--primary`) → `@theme inline` as `--color-primary`. Dark via `.dark` class, not `prefers-color-scheme`. Hex throughout. |
| Conformance | Genuinely clean. **0** real hardcoded colors in the app layer; **4** files total with non-semantic color utilities; **64/64** eligible screens on `ScreenTemplate`; `SheetContent` outside `shared/detail/` is **0**. |
| Type | No scale. Tailwind stock + one `--text-2xs` (11px). `text-xs` and `text-sm` are **2,175 of 2,517** call sites. |
| Test surface | 318 Storybook stories, 84 unit tests, 67 `vitest-axe` files, 36 Playwright e2e a11y specs. |

### The Gate Gap — the single largest risk in this ticket

**A palette change will pass CI today while silently regressing contrast across 72 screens.**

| Assumed gate | Reality |
|---|---|
| 50 console + 17 `packages/ui` `vitest-axe` files | **Contrast-inert.** happy-dom; axe skips `color-contrast` when it cannot resolve the rendered color stack. The repo's own helper documents this: *"a jsdom or happy-dom scan of the same markup reports zero violations no matter how bad the palette is."* (`packages/ui/src/components/__tests__/helpers/axe.ts:9-12`) |
| 36 `@axe-core/playwright` e2e specs (real browser, no rule disabled) | **Not wired to any CI job.** `.gitlab/ci/test.yml:214-216`: *"remains local-discipline until a nightly/scheduled job is built for it."* No such job exists. |
| `test-ui-ct` — holds the only 2 genuine contrast tests | **Off by default** (`RUN_UI_CT != "true"` → `when: never`) **and** `allow_failure: true` |
| Chromatic visual regression | **Not wired.** Addon dependency only — no script, no CI job, no project token, no stored snapshots. |
| Playwright screenshots / `.snap` files | **None exist.** Zero `toHaveScreenshot`, `toMatchSnapshot`, or `.snap` files repo-wide. |
| ESLint / stylelint on color | **None exist.** No styling rule in the entire config family. |

The only job that fails on day one is **`test-sdk`**, via `packages/ui/src/styles/__tests__/accent-tokens.vitest.ts`, which hardcodes `--teal-600` as the default `--primary` and asserts the three `data-accent` blocks exist.

**Consequence: Phase 2 builds the gate. It does not repair one.**

### What survives the migration untouched

TASK-765's foundation is largely Tatva-conformant already:

| Layer | Verdict |
|---|---|
| Reduced motion at the token layer | **Already Tatva's BP-01, adopted verbatim.** Zero change. |
| Z-index scale (`z-base/raised/sticky/chrome/overlay/toast`) | **Already satisfies Tatva's EX-05 prescription** and is finer-grained. Zero change. |
| `--ease-spring: cubic-bezier(0.34,1.42,0.5,1)` | **Exact match.** Zero change. |
| Durations `instant/fast/slow/reveal/slower` | Exact match. Only `normal` moves (200ms → 160ms). |
| Focus canon (`outline-hidden`, no alpha'd rings) | Structurally compatible; only the ring *color* changes. |
| Fonts | Tatva's families (Matter, Season Mix, Matter Mono) are **proprietary and excluded from any rebuild**. HOPE keeps Inter / Source Serif 4 / JetBrains Mono. |

---

## Geometry Contract

**This replaces the skipped Figma gate (OD-4).** Sarvam's investigation observed only 11 component
treatments; 48 of HOPE's 57 primitives have no reference data. These rules determine them
mechanically so nothing is invented at the keyboard.

| Rule | Value | Governs |
|---|---|---|
| Control height | `sm 28px` · `md 36px` · `lg 44px` · `avatar 40px` · `xs 24px` (HOPE-only, WCAG 2.5.8 floor) | every interactive control |
| Control radius | pill (`--radius-full`, 3996px) | anything clickable with no content flow — button, toggle, badge, chip, pagination |
| Field radius | 12px (`--radius-surface`) | input, textarea, select trigger, OTP cell — **a pill text field is a search idiom, not a form idiom** |
| Container radius | 12px card / 20px dialog | card, popover, dropdown, menu, tooltip = 12px; modal dialog, alert-dialog, sheet, drawer = 20px |

**J-15 — express radius by ROLE, not by raw scale step.** Phase 1 shipped semantic aliases
`--radius-surface` (12px), `--radius-overlay` (20px) and `--radius-control` (pill), generating
`rounded-surface` / `rounded-overlay` / `rounded-control`. Use those wherever a role applies.
`rounded-md`/`rounded-lg`/`rounded-full` produce identical pixels today but express a scale
position rather than an intent, and would silently diverge from the role the first time the scale
is retuned — which is the whole reason the `calc()` base architecture exists. Raw steps stay
correct only where no role fits (e.g. `rounded-xs` on a checkbox). Raised by the Phase 3 agent
2026-08-22; resolved the same day.
| Border | 1px hairline, always present | every surface edge |
| Elevation | **flat — `none`** | all surfaces. Depth is border+surface in light, tonal surfaces in dark |
| Overlay depth | scrim `#14141480` + `backdrop-filter: blur(4px)` | modals only |
| Weights | **400 and 500 only** | all text. No 600/700 anywhere |
| Density | 20px card padding · 28px section rhythm · 4px grid | layout |
| Focus | 2px ring, 2px offset, `--ring` at full opacity | every focusable element |

**States are NOT covered by this contract and NOT covered by Tatva.** `05-states.md` records
disabled, loading, empty, error and success as **unobserved on every surface, both themes, all three
viewports**. These five must be authored from `11-ux-ui-principles.md` and the `web-accessibility`
skill. Any claim of Tatva coverage for them is false.

---

## Implementation Plan

### Phase sequencing

`globals.css` is a single write target every other file consumes. TASK-765 recorded the remedy:
*"globals.css is the write target for every token scale, so it gets a single author; the sweeps only
consume what it declares."* Phases 1, 2 and 6 are **single-author, no parallelism**. Phases 3–5 run
in parallel on strictly disjoint trees.

| # | Phase | Parallel | Write scope | Exit gate |
|---|---|---|---|---|
| **1** | Token foundation | **No** | `packages/ui/src/styles/globals.css` | Emitted-bundle grep proves every utility resolves |
| **2** | Build the contrast gate | **No** | test files, `.gitlab/ci/test.yml`, axe config | A deliberately-bad token value fails CI |
| **3** | Primitives | ✅ | `packages/ui/src/components/shadcn/**` | 57 primitives match the Geometry Contract, both themes |
| **4** | Library + registries | ✅ | `packages/ui/src/components/**` minus `shadcn/` | Vendored-file changes logged for upstream re-apply |
| **5** | Console sweep | ✅ | `apps/admin-console/src/**` | Codemod diff reviewed, not hand-edits |
| **6** | Nav IA | **No** — separate ticket | shell + `nav-config.ts` | See §Phase 6 |
| **7** | Verification | Orchestrator | — | Full gate suite + manual a11y pass |

### Phase 1 — token foundation (single author)

**1a. calc() base architecture (Tatva BP-04).** Three authored variables in `:root`:

```css
:root {
  --hope-spacing-base:   2px;
  --hope-radius-base:    4px;
  --hope-font-size-base: 12px;
}
```

Mechanism confirmed working — `globals.css` already ships `calc(var(--radius) - 4px)` inside
`@theme inline` in production. Three caveats that must be carried:

1. The bases must live in `:root`, not inside `@theme inline` — `@theme inline` inlines the literal
   text of the value, so the `var()` must resolve against a real custom property at paint time.
2. **Only `--spacing` has a native multiplier.** Tailwind generates `p-<n>`/`gap-<n>`/`size-<n>` as
   `calc(var(--spacing) * <n>)`. There is no equivalent for `--radius-*` or `--text-*` — every step
   must be hand-authored.
3. **There is no `--duration-*` theme namespace.** Named durations stay as the existing six
   `@utility duration-*` rules. This is already recorded in `globals.css`.

**1b. Palette.** Delete `--teal-*` (11 steps, no successor). Replace `--slate-*` 1:1 with
`--neutral-*`. Re-value indigo/green/red/saffron/amber from Tatva's accent primitives. Two authored
steps with no Tatva source: `--neutral-550: #6a6a6a` and `--neutral-450: #8a8a8a`.

Headline role changes:

| Token | From | To (light / dark) |
|---|---|---|
| `--primary` | `#0f7a8b` teal-600 | **`#141414` / `#e8e8e8`** — primary is near-black, not a hue |
| `--background` | `#fbfcfd` | `#fafafa` / `#242424` |
| `--card` | `#ffffff` / `#111d23` | `#ffffff` / **`#1e1e1e`** — note dark raised is *darker* than dark canvas, reversing HOPE's current relationship |
| `--ring` | `#0f7a8b` | **`#141414` / `#e4e4e4`** — EX-01 prescribed fix; 2.10:1 → **18.42:1** |
| `--muted-foreground` | `#5a6a77` | `#525252` / `#949494` |
| `--input` | = `--border` | **`#8a8a8a` / `#6f6f6f`** — split from `--border`; fixes a pre-existing 1.22:1 failure |

**1c. The EX-04 correction.** Sarvam prescribes `#767676`, calibrated against `#ffffff` only:

| value | on `#ffffff` | on `#fafafa` | on `#f5f5f5` | on `#f0f0f0` |
|---|---|---|---|---|
| `#999999` (measured) | 2.85 ✗ | 2.73 ✗ | — | — |
| `#767676` (EX-04 prescribed) | 4.54 ✓ | **4.35 ✗** | — | — |
| **`#6a6a6a` (use this)** | **5.41 ✓** | **5.18 ✓** | **4.96 ✓** | **4.75 ✓** |

Dark equivalent: Tatva's `dark.muted #646464` is 2.62:1 — fails. Use `#8f8f8f`.

⚠️ **Dark-theme emphasis collapse.** `#8f8f8f` (tertiary) and `#949494` (secondary) sit 0.35 apart —
visually indistinguishable. Neither clears 4.5:1 on `--secondary #343434`. **Hard rule for the
ticket: in dark theme, no secondary or tertiary text on a `--secondary`/`--accent` fill.** Badges
and chips in dark use `--foreground`.

**1d. Geometry, elevation, motion.** Radius set per the Geometry Contract; `--radius: 0.625rem`
deleted. Elevation roles keep their names (`shadow-flat/raised/overlay`) and are re-valued to `none`
— **call sites do not churn**. New tokens: `--overlay-scrim`, `--overlay-blur`, `--focus-ring-width`,
`--focus-ring-offset`, `--scale-pressed: 0.97`. Motion: `normal` 200ms → 160ms; resolve J-10.

### Phase 2 — build the contrast gate (single author, blocks Phase 3)

1. **Token-level contrast test** — computes ratios directly from `globals.css` for every
   foreground/background pair and asserts AC-2. Browser-independent, so it runs in `test-sdk`.
   This is the primary gate and the one that must exist before any sweep lands.
2. **Wire the 36-spec e2e a11y suite** into a scheduled CI job. It is the only real-browser contrast
   check in the repo.
3. **Flip `RUN_UI_CT=true`** for this ticket's pipelines and drop `allow_failure`.
4. **Rewrite or delete `accent-tokens.vitest.ts`** per J-4.
5. Update the `focus-canon.vitest.ts` doc comments — its cited ratios and its "tokens are HEX" note
   go stale. The assertions themselves survive unchanged.

**Validation of the gate itself:** introduce a deliberately-bad token value and confirm CI fails.
A gate that has never failed is not known to work.

### Phase 3 — primitives (`shadcn/**`)

57 files. The headline change is **buttons become pills** (`rounded-md` 8px → `rounded-full`), per
Tatva's measured canon for primary/secondary/icon/chip. Also: card `rounded-xl` 14px → 12px;
dialog `rounded-lg` 10px → **20px** (doubles); `sm` controls 32px → 28px; `lg` controls 40px → 44px
(an accessibility gain — Tatva's 44px is the only step meeting the comfort bar).

`default`/`icon` at 36px is an **exact match** to `control.md` — no change.

**Do not reproduce Tatva's component behaviour, only its geometry.** Specifically: EX-09 (its dialog
has no close control and ignores Escape and scrim-click) and EX-11 (its tablist is
`pointer-events:none` with `tabindex=0`). Keep Radix defaults for both.

### Phase 4 — library + registries

The real elevation surface is **not** the 9 role-token call sites — it is **152 stock Tailwind shadow
uses** (`shadow-xs` 53, `shadow-sm` 51, `shadow-md` 25, `shadow-lg` 24) that must go flat. Note 6 of
the 12 role-token uses are in the third-party `einui` glass registry, where flattening would destroy
the glassmorphism intent — treat as an exception, matching TASK-765's precedent.

Log every vendored `registries/**` file touched. TASK-765 modified 29 and they need re-applying on
upstream sync.

### Phase 5 — console sweep (codemod, not hand-edits)

**2,517 type call sites.** 94.1% keep their font-size — only line-height moves. Do not hand-edit
this; write a codemod and review the transform.

| Change | Sites |
|---|---|
| `text-2xs` 11px → 12px (J-5) | 115 |
| `text-3xl` 30px → 32px | 12 |
| `text-4xl` 36px → 32px (J-6) | 19 |
| Line-height tightens at every step except 16px | 2,517 |
| `font-semibold`/`font-bold` → `font-medium` | not yet counted — count before starting |

⚠️ Line-height compression is the under-estimated risk: `text-xs` 16→14 (−12.5%), `text-lg`/`text-xl`
28→24 (−14%). Anything relying on `leading-*` to hit a pixel height — badges, chips, table rows —
shifts. Ship line-height with the spacing migration, not separately.

### Phase 6 — nav IA → **split out as [TASK-788](../TASK-788-Domain-Rail-Navigation/README.md)**

Closes **HOPE-16**. Owner selected the **domain rail** axis on 2026-08-22: keep audience tiers for
guards, add a domain axis for presentation. 55 routes partition into 9 domains of 3–10 each.

**Sequencing is strictly serial: TASK-788 starts only after Phase 5 merges.** Phase 5 writes broadly
across `apps/admin-console/src/**` and TASK-788 rewrites the shell plus `nav-config.ts` — running
them concurrently violates one-writer-per-file, and there is no safe partition.

---

## Resolved Decisions — J-1…J-12

**All twelve resolved by the owner on 2026-08-22, as recommended. AC-7 is satisfied; Phase 3 is
unblocked.** Recorded here as binding — a phase agent implements these, it does not re-open them.

| # | Decision | Resolution | Consequence for the sweeps |
|---|---|---|---|
| J-1 | `--background` light | **`#fafafa`** (achromatic). Rejects the observed `#f7f5f3`, which is warm and, per Tatva's §5, painted by the *legacy* namespace OD-3 deletes | Phase 1 |
| J-2 | `--secondary` / `--accent` collide at `#f0f0f0` | **Accept the collision** — Tatva uses one sunken fill for both. Add `--secondary-hover` / `--accent-hover` at `#e6e6e6` | Phase 1 |
| J-3 | `--primary-strong` collapses into `--primary` | **Keep as an alias.** Zero call-site churn; the token stays meaningful in dark | Phase 1 |
| J-4 | `data-accent` theme axis | **DELETE** — 6 selectors, 45 declarations. With `--primary` and `--ring` both `#141414` the axis has nothing left to vary | Phase 1 (CSS) + Phase 2 (delete `accent-tokens.vitest.ts`) + Phase 4 (retire `accent-themes.stories.tsx`) |
| J-5 | `--text-2xs` 11px, 115 sites | **Collapse to 12px, delete the token.** 11px is below most density guidance; Tatva's floor is 12px and the scale stays purely additive | Phase 1 + Phase 5 codemod (66 admin + 49 ui) |
| J-6 | `text-4xl` 36px, 19 sites | **Collapse to 32px.** Tatva's ladder tops out at `heading-xl`; an admin console has no 36px surface | Phase 5 codemod. `text-3xl`/`text-4xl` become one size — 31 sites lose a hierarchy level |
| J-7 | Button `xs` = 24px | **Keep.** Sits exactly on the WCAG 2.5.8 floor; folding into `sm@28` would touch every dense-toolbar call site | Phase 3 — mark as a documented HOPE-only extension below Tatva's scale |
| J-8 | Form-control radius | **12px** (`--radius-surface`). A pill text field is a search idiom, not a form idiom | Phase 3 — input, textarea, select trigger, OTP cell |
| J-9 | Menu/popover radius + flatness | **12px, 1px `--border`, `--popover` surface, no shadow** | Phase 3 — ⚠️ see the watch item below |
| J-10 | `--ease-emphasized` holds Tatva's `ease-out` value | **Re-value `--ease-emphasized` to `(0.16,1,0.3,1)`; add `--ease-out: (0.23,1,0.32,1)`; repoint dialog entrance at `--ease-out` + `duration-slow`** — the exact pairing Tatva measured | Phase 1. Also add `--ease-in-out: (0.645,0.045,0.355,1)`; `--ease-in` needs no override |
| J-11 | Sidebar active item — EX-12, 1.14:1 | **Fill + `font-weight: 500` + 2px `--foreground` left rule.** EX-12's own ≥3:1 fill guardrail is unachievable with an achromatic palette on a white sidebar, so the fill cannot be the sole signal | **Implemented in [TASK-788](../TASK-788-Domain-Rail-Navigation/README.md) AC-5**, not here |
| J-12 | 152 stock shadow call sites | **Sweep to flat.** Includes `shadow-xs` on the `outline` button variant — it becomes border-only | Phase 4 |

### J-13 / J-14 — raised during Phase 1 execution, resolved 2026-08-22

Both surfaced by the Phase 1 agent and confirmed by the orchestrator against the emitted bundle.

| # | Decision | Resolution |
|---|---|---|
| J-13 | The two authored neutral steps made the ramp **non-monotonic** — `--neutral-450: #8a8a8a` is darker than `--neutral-500: #999999` | The VALUE is right for `--input`; the NAME was wrong. Renumber to **`--neutral-520`** (`#8a8a8a`) and **`--neutral-560`** (`#6a6a6a`), giving `400 → 500 → 520 → 560 → 600` |
| J-14 | `--radius-2xl` / `--radius-3xl` were never declared, so they fall through to Tailwind stock 16px/24px — now **below** `--radius-xl` (28px), across 30 + 2 call sites | **Extend the ladder monotonically** rather than sweep 32 sites for no design reason: `--radius-2xl` = base×9 (36px), `--radius-3xl` = base×12 (48px). Zero call-site churn. Documented as HOPE-only extensions above Tatva's authored scale, which closes at 28px |

### Watch item — J-9 is the one resolution not proven by the reference

A borderless flat menu over a flat card is hard to separate, and **Tatva's only measured overlay was
a scrim'd modal** — its flatness is not evidence for menus. The resolution above ships, but Phase 3
must verify menu/popover separation explicitly in both themes before Phase 7 signs off. If
separation fails, the sanctioned fallback is `--elevation-raised` restored for *menus only*, which
is a one-line change and does not reopen J-12.

### Consequential note on J-5 and J-6

Both are deletions of expressive range, taken deliberately:

- **J-5** removes the only step below 12px. TASK-765 created `--text-2xs` specifically to replace 58
  `text-[10px]` and 8 `text-[11px]` literals and documented it as *"the ONE declared step below
  `text-xs` … nothing may go below it."* Collapsing to 12px grows every dense-metadata surface ~9% —
  data-grid chrome, status-badge captions, timestamp columns, `StatusFooter`. **Phase 5 must check
  column widths and row heights on the densest grids**, not just compile.
- **J-6** collapses `text-3xl` and `text-4xl` to the same size. Any surface using both to build a
  hierarchy loses a level and must re-express it through weight or color — noting that weight is
  itself constrained to 400/500 by the Geometry Contract.

---

## J-17 / J-18 — surfaced by Phase 5, RESOLVED 2026-08-22 (`3f6c129d3`)

Neither is a defect in the migration. Both are consequences of the achromatic
identity (OD-1) that only become visible once the whole system is on it.

### J-17 — `text-primary` is no longer an emphasis signal. **142 sites.**

`--primary` and `--foreground` resolve to the SAME token in light
(`var(--neutral-900)`) and to 1.03:1 in dark. Any UI that used `text-primary`
to mean *emphasised / active / selected* now has no signal at all. Phase 5 hit
this concretely: `audio-pipelines-screen.tsx:118` was
`selected ? 'text-primary font-semibold' : 'font-medium'`, and under the new
palette **both branches collapsed to identical rendering** — the selected row
became invisible. It was re-expressed as `font-medium` vs `font-normal`.

Distribution: 20 billingsdk · 15 manifest · 14 shadcn · 12 prompt-kit · 6 diceui ·
6 basecn · 4 magicui · 4 playground-llm · rest scattered.

**RESOLVED — Accept, and guard it.** This IS the Tatva model: emphasis comes from
weight, size and position, not hue.

The audit was the valuable half. Every in-scope site was read in context, and
**three** genuine collapses were found where `text-primary` was THE branch
differentiator — not the one already known:

| Site | Impact | Re-expressed as |
|---|---|---|
| `custom/workflow-toggle.tsx:61` | Both branches were `font-medium`; the selected option's **label was invisible** (card kept `border-primary` + radio dot, so impaired not dead) | weight 500 / 400 |
| `transcription-jobs-screen.tsx:129` | Unselected branch was an empty string relying on an inherited weight — one restyle from collapsing | weight 500 / 400, pinned |
| `playground-llm-screen.tsx:136` | "Notable" emphasis in a meta strip, gone | weight 500 / 400 |

~20 further conditionals were checked and keep a working signal (distinct icons,
fills, muted-vs-foreground pairs, presence/absence), so sweeping them is a pixel
no-op. **48 occurrences → `text-foreground` across 41 files.**
`text-primary-foreground` is a different token and untouched (53 intact).

**42 vendored `registries/**` sites are deliberately exempt** — sweeping them
costs re-application on every upstream sync for zero visual change.

Guarded per tree (a guard in one package cannot fail the other's CI job):
`packages/ui/src/components/__tests__/emphasis-canon.vitest.ts` and
`apps/admin-console/src/shared/__tests__/emphasis-canon.test.ts`. The
`packages/ui` guard also **pins the vendored exemption as real** — it fails if
`registries/` ever reaches zero hits, so the exemption cannot quietly become an
unlogged sweep. Both validated by deliberate reintroduction.

*Not taken:* introducing an accent ink (`--link: #3333cc`, already declared).
That would depart from the achromatic discipline the reference records as
deliberate. The place it would land if ever revisited is the `link` variant of
`Button` and `Badge`, which now read `text-foreground` with `hover:underline`
as the sole affordance.

### J-18 — 110 `<hN>` section headings are now pixel-identical to `<Label>`

The 400/500 weight rule collapses `text-sm … font-medium` headings onto the
`Label` primitive's exact `text-sm leading-none font-medium`
(`packages/ui/src/components/shadcn/label.tsx:13`). 29 headings at `text-base`+
stay above it.

**RESOLVED — fix the primitive, not the 110 call sites.** `Label` becomes
`font-normal`; headings keep `font-medium`. A label is a descriptor, a heading is
a title. One file instead of 110, and it preserves the console's deliberate
12–14px density — bumping every heading to `text-base` would have made card
headers 16px in a product whose body text is 12–14px.

Contrast is unaffected and was **checked, not assumed**: this changes
`font-weight` only, no colour token moves, and `text-sm` is 14px at weight 400 —
not bold — so the same 4.5:1 floor applied before and applies after. One test
moved (`label.test.tsx:30`); the other 15 `font-medium` assertions target
components carrying their own weight and were verified unaffected.

**Follow-up CLOSED 2026-08-22 (`c1484d0eb`) — and the recorded estimate was wrong.**
Measured: of **317** `<Label>` usages, 21 override to `font-medium`, and only
**4** are the collision.

| Override | Count | Collides? |
|---|---|---|
| `text-sm font-medium` | **4** | **Yes** — same size AND weight as a section heading |
| `text-xs font-medium` | 17 | **No** — 12px, usually `text-muted-foreground`; differs from a 14px foreground heading by both size and colour |

The four were fixed (`security-policy-screen.tsx`, `tenant-settings-tab.tsx`,
`dept-prompt-selector.tsx` ×2) — all setting-row titles where `text-sm` is
already the `Label` default, so only `font-medium` was doing damage.

**The 17 are deliberately kept.** They never collided, and dropping them to 400
would reduce legibility at 12px muted — stripping them would be churn that makes
text harder to read in service of a consistency the primitive does not need.

Guarded: the console emphasis canon now also fails on a `<Label>` carrying both
`text-sm` and `font-medium`, with `text-xs` explicitly not matched. Validated by
reintroduction.

## Team Execution Practices

1. **One writer per file, per branch.** If two tasks would touch the same file, they are one task.
   Each parallel worker gets its own `git worktree` branched from the current active branch.
2. **The orchestrator alone owns shared surfaces** — merges, `pnpm install`, branch switches, any
   Docker/DB command. A worker that resets shared state destroys its siblings' runs.
3. **Never `git stash` in a worktree.** The stash stack is shared repo-wide. Commit, then
   `git checkout HEAD~1 -- <path>` for a baseline.
4. **Compile-and-grep, don't trust source.** Every token claim is verified against the emitted
   admin-console bundle. TASK-765's `--tw-duration` defect was invisible in source and caught only
   this way.
5. **Codemod the sweeps.** 2,517 type sites and 152 shadow sites are not hand-edit surfaces.
6. **Log every vendored `registries/**` file touched** — unlogged ones are silently lost on upstream sync.
7. **Evidence, not assertions.** Every phase report pastes real command output.
8. **Merge before cleanup.** Never remove a worktree with unmerged commits; confirm the target
   branch with the owner rather than assuming `dev`.

---

## Verification

Run by the orchestrator after all sweeps:

```
pnpm --filter @arcaai/ui lint typecheck test
pnpm --filter @arcaai/admin-console lint typecheck test build
RUN_UI_CT=true pnpm --filter @arcaai/ui test:ct
pnpm --filter @arcaai/admin-console exec playwright test   # the 36 a11y specs
```

Plus: emitted-bundle greps for every new utility; the deliberately-bad-token gate validation from
Phase 2; and the manual keyboard + 200%-zoom pass from the `web-accessibility` skill (automation
catches ≲57%).

---

## Implementation Summary

### Phase 2 — the contrast gate (landed 2026-08-22)

**AC-4 is met.** A palette change can no longer pass CI while regressing contrast.

| # | Deliverable | Outcome |
|---|---|---|
| 1 | `packages/ui/src/styles/__tests__/token-contrast.vitest.ts` (NEW) | Parses `globals.css`, resolves every role through its `var()` chain to a concrete hex in both themes, computes the WCAG 2.x ratio arithmetically. **150 enforced pairs** (74 light / 76 dark) + **20 pinned exemptions**. Browser-independent — runs in `test-sdk`. |
| 2 | `test-admin-console-a11y` in `.gitlab/ci/test.yml` (NEW) | Scheduled, opt-in (`RUN_A11Y_E2E=true`) job that composes gateway + seeded DB + a production console build and runs the 40 `@axe-core/playwright` specs. **Written, not proven on a runner** — see the two blockers below. |
| 3 | `test-ui-ct` | `RUN_UI_CT != "true" → when: never` and `allow_failure: true` both removed. The two genuine rendered-contrast tests now block. |
| 4 | `accent-tokens.vitest.ts` | **Deleted** (J-4). Two invariants migrated into the new gate, inverted: no `data-accent` axis may return, and no `--teal-*` reference may survive. |
| 5 | `focus-canon.vitest.ts` | Comments only. Ratios refreshed to `--ring` 17.65:1 light / 12.21:1 dark; the "tokens are HEX" note re-anchored off the retired teal example. Assertions untouched. |

**Gate validated by deliberate failure.** `--muted-foreground` was set to `#b3b3b3`; the gate
failed naming each offending pair and its ratio (`--muted-foreground (#b3b3b3) on --card (#ffffff)
= 2.10:1, below the 4.5:1 WCAG 1.4.3 text floor [light]`, and four more). `globals.css` was then
reverted exactly.

**Two findings the phase brief did not anticipate — both encoded as pinned exemptions, neither
silently dropped:**

1. **`--hope` as bare text fails in light** (3.22:1 on `--background`, 3.36:1 on `--card`) — the
   same adjudication as `--warning`, and for the same reason: it is a FILL, and `--hope-strong`
   (#a8410c, 5.87:1) is the text step. `globals.css` already documents this; the brief named only
   `--warning`. Dark stays enforced, since the lightened tints clear 4.5:1 as text.
2. **Dark `--muted-foreground` (4.10:1) and `--muted-foreground-subtle` (3.85:1) on `--secondary`**
   — the "dark-theme emphasis collapse" hard rule already written into `globals.css`. Encoded as a
   PROHIBITION rather than a tolerance: the exemption is pinned, and a companion assertion proves
   the prescribed alternative (`--foreground` on `--secondary`/`--accent`, 9.79:1) actually clears
   the floor, so the rule is enforceable rather than merely recorded.

`--sidebar-accent` vs `--sidebar` (J-11) is pinned as an exemption that carries an **open** a11y
debt, not a closed decision — the second and third signals land in TASK-788 AC-5.

**Not done — the composed stack is only partly expressible in this repo's CI today:**

- **No `CI_ADMIN_SESSION_SECRET` variable exists.** The console refuses to boot without
  `ADMIN_SESSION_SECRET` (≥32 chars, `src/config/env.ts`, `required: true`). The job hard-fails
  with a named message rather than booting a broken stack.
- **Redis provisioning is unconfirmed.** `test-api-e2e` records that `CI_REDIS_URL` and the API
  secrets are *not* provisioned, which is why that job is `RUN_INFRA_TESTS != "true" → never`.
  The new job inherits that uncertainty.
- **`CI_PIPELINE_SOURCE == "schedule"` is not handled in `.gitlab-ci.yml`'s workflow rules.** A
  scheduled pipeline on `dev-2.2` resolves to `PIPELINE_TYPE=dev` + `SKIP_TESTS=true`, so every
  test job — including this one — is skipped. The schedule must target a branch that does not
  opt out, or the workflow rules need a `schedule` arm.
- **The skip trap is guarded, not wished away.** `tests/e2e/helpers/stack.ts` makes specs SKIP
  when the stack is unreachable, so a naive job reports green having asserted nothing. The job
  hard-exits if either health probe fails and fails if fewer than `MIN_EXPECTED_SPECS` (30) tests
  actually executed.

**Threshold check on `tabs.test.tsx`:** its hardcoded 4.5:1 assumes 14px text and **still holds**.
`text-sm` resolves to `calc(12px + 2px)` = 14px under the new scale, and `font-medium` (500) is
not bold, so WCAG's large-text relaxation does not apply. No size-awareness is needed. The tokens
it measures clear the bar comfortably: inactive trigger `--muted-foreground` on `--muted` is
7.17:1 light / 5.50:1 dark; on the transparent `line` variant's `--background` ancestor, 7.49:1 /
5.12:1.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-22 | Ticket opened. Two read-only discovery agents mapped the Tatva reference and HOPE's current state; two further agents enumerated gate breakage and produced the full token mapping with computed contrast ratios. Owner decisions OD-1…OD-5 recorded. Plan drafted; 12 judgement calls raised for resolution before Phase 3. Status: Pending. |
| 2026-08-22 | Owner selected the **domain rail** axis for the nav IA. Phase 6 split out as [TASK-788](../TASK-788-Domain-Rail-Navigation/README.md) per OD-5, with a strict serial dependency on Phase 5. J-11 (sidebar active-item second signal) is now consumed by TASK-788 AC-5 — resolve it here, implement it there. |
| 2026-08-22 | **Owner resolved all twelve judgement calls as recommended (OD-6).** AC-7 met; Phase 3 unblocked. Notable outcomes: `data-accent` is deleted outright (J-4), `--text-2xs` collapses to 12px across 115 sites (J-5), `text-3xl`/`text-4xl` merge at 32px (J-6), and all 152 stock shadow call sites go flat (J-12). J-9 (flat borderless menus) recorded as a **watch item** — it is the one resolution the reference does not evidence, with `--elevation-raised` for menus only as the sanctioned fallback if Phase 3 finds separation fails. |
| 2026-08-22 | **Renumbered TASK-785 → TASK-787.** `TASK-785` was already taken by an in-flight concurrent workstream (`TASK-785-Tiered-Rate-Limit-Governance`, status *In Progress*, with a landed migration `20260822051931_task_785_rate_limit_rules`). Caught before any commit, so no history rewrite was needed. Sibling renumbered TASK-786 → TASK-788 in the same pass; all cross-references updated and verified clean. |
| 2026-08-22 | **Baseline moved mid-planning — counts are a floor, not a contract.** Two commits landed during this ticket's planning (`8a2449816` TASK-786 credential policy, `f8c8e1b4a` TASK-785 tiered rate-limits), adding the `/security-policy` screen and four `rate-limits` panel components. All static counts in this document (2,517 type call sites, 152 stock shadow uses, 115 `text-2xs`, 19 `text-4xl`) were measured at `d97e9b71e` and are now low. **Every phase agent MUST re-measure its own scope before sweeping** and report the delta — do not sweep to the numbers written here. The mapping, the resolved decisions and the geometry contract are unaffected; only the volumes moved. |
| 2026-08-22 | **All five phases executed and merged to `dev-2.2`.** J-13…J-16 raised and resolved during execution; J-17 (142 `text-primary` sites no longer an emphasis signal) and J-18 (110 headings pixel-identical to `Label`) surfaced by Phase 5 and left OPEN for an owner decision. Gates green both packages. Status → Review. |
| 2026-08-22 | **J-17 and J-18 resolved (`3f6c129d3`); ticket closed out.** The J-17 audit found **three** branch-differentiator collapses, not the one already known — `workflow-toggle.tsx` had rendered a selected label invisibly. 48 sites swept, 42 vendored deliberately exempt, both trees guarded with a test that also pins the exemption as real. J-18 fixed at the `Label` primitive rather than 110 call sites. Also deleted `accent-themes.stories.tsx` (`08923ac51`), which still documented the `data-accent` feature J-4 removed. Full verification: `@arcaai/ui` 708/708 + **1717 CT (0 failed)**, `@arcaai/admin-console` 1762/1762, lint/typecheck/build clean both. The e2e a11y suite remains unverifiable here — pre-existing, owned by TASK-772. |
| 2026-08-22 | **J-18 follow-up closed (`c1484d0eb`).** Re-measuring corrected the recorded estimate: not ~14 colliding call sites but **4**, out of 317 `<Label>` usages and 21 `font-medium` overrides. The other 17 are `text-xs` and never collided; they are kept, because 400 at 12px muted is less legible. Guard extended to the `<Label>` + `text-sm` + `font-medium` shape. Final verification: `@arcaai/ui` 708/708 + 1717 CT (0 failed), `@arcaai/admin-console` 1763/1763, lint/typecheck/build clean both. |
