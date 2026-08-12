# TASK-540 — ESLint Suppression Debt: Policy + Phased Remediation

| | |
|---|---|
| **Status** | Closed |
| **Type** | refactor |
| **Created** | 2026-07-21 |
| **Origin** | Spun out of the TASK-536 comment-debt inventory (2026-07-21), which declared suppression debt out of scope for provenance cleanup |
| **Scope** | Originally scoped as policy + plan only (mass edits deferred to follow-up tickets). On 2026-07-21 the owner asked for full execution in this same ticket — see Change History. The plan below is retained as designed; the Implementation Summary tracks actual execution against it. |

## Owner Decisions (ratified 2026-07-21, superseding the "Open Questions" section)

1. **Grandfathering**: option (b) — enable `eslint-comments/require-description` at `warn` repo-wide immediately (Phase 0), promote to `error` per-package as that package's backlog clears (apps/api first, since it has no `only-warn` safety net; then repo-wide once every package is clean).
2. **Hand-authored `domains/*/generated/core/` files**: moot — these paths are already fully covered by each consuming package's own `ignores` (`**/generated/**`), so ESLint never lints them at all; any disable comment inside them is inert. No special rule carve-out needed.
3. **Reason format**: free text after ` -- `, no mandatory ticket reference. A short, specific rationale is required; citing a ticket is encouraged when the reason IS a known ticket's decision but not otherwise mandated.

## Requirement Analysis

The TASK-536 inventory found a large body of `eslint-disable` comments with no recorded
justification. An unjustified suppression is indistinguishable from a lazy one: reviewers
cannot tell whether the violation is a sanctioned exception (e.g. the `only-warn` caveat in
`01-development-workflow.md`) or debt. Requirements:

1. **Re-verify the counts** with a reproducible methodology (done — see below).
2. **Propose a policy** so new suppressions carry a reason going forward.
3. **Propose a phased remediation plan** for the existing backlog, deciding per rule family
   whether to *fix the code* or *justify the suppression*.
4. Explicitly **not** in scope: mass-editing code, touching vendored registries
   (`packages/ui/src/components/registries/**`), or the deprecated `apps/ui-playground`.

## Current State Evaluation

### Verified counts (2026-07-21, branch `fix/2605-review`)

Methodology: git-tracked files only (`git ls-files | xargs rg`). "Bare" = an
`eslint-disable-next-line <rule>` comment with no ` -- reason` suffix.

| Metric | TASK-536 inventory | Re-verified | Command sketch |
|---|---|---|---|
| Total `eslint-disable*` occurrences | 1,784 | **1,744** | `rg -c 'eslint-disable'` over tracked files |
| Bare `eslint-disable-next-line <rule>` | 827 | **848** | above, filtered to next-line with a rule and no ` -- ` |
| Bare, outside vendored registries | 804 | **824** | additionally excluding `packages/ui/src/components/registries/**` |

The ±2–3% drift vs the inventory is methodology noise (working-tree vs tracked files,
strictness of the "no justification" pattern); the shape of the problem is identical.

### Where the bare suppressions live (outside vendored code)

| Package/app | Bare suppressions | Notes |
|---|---|---|
| `packages/applications` | 431 | Largest hotspot — service layer |
| `apps/api` | 122 | Lint violations are HARD errors here, so each of these is a deliberate opt-out |
| `packages/domains` | 99 | Includes hand-authored `generated/` trio files |
| `apps/ui-playground` | 92 | DEPRECATED app — exclude from remediation |
| `packages/agentic-sdk-v2` | 32 | |
| others (med-ner, ui, stt, database, room, …) | ~48 | Long tail |

### Rule-family breakdown (all `eslint-disable-next-line`, repo-wide)

| Rule | Count | Character |
|---|---|---|
| `@typescript-eslint/no-explicit-any` | 624 | Type-safety debt; mostly fixable (`unknown`, generics, Prisma types) but expensive |
| `@typescript-eslint/no-unused-vars` | 128 | Mostly mechanically fixable (`_`-prefix convention or delete) |
| `turbo/no-undeclared-env-vars` | 66 | Often signals a real gap — env var missing from `turbo.json#globalEnv` |
| `no-restricted-imports` / `no-restricted-syntax` | 15 | Architecture-boundary opt-outs — HIGH review value; each needs an explicit reason |
| `no-console` | 11 | Should route through `@arcaai/logger` or be justified (CLIs/scripts) |
| `@typescript-eslint/no-empty-object-type`, `ban-ts-comment`, `no-require-imports`, misc | ~35 | Case-by-case tail |

### Existing tooling

- No `eslint-comments` plugin is installed anywhere (checked `packages/config-eslint`,
  root `package.json`, lockfile).
- ESLint 10 flat presets live in `packages/config-eslint/flat/{core,library,nestjs,next,react-library}.js`
  (TASK-418) — a single insertion point exists for a repo-wide comment-hygiene rule.
- Caveat from `01-development-workflow.md`: `packages/*` runs `eslint-plugin-only-warn`, so
  a new rule there surfaces as warnings; in `apps/api` it would be a hard error immediately.

## Implementation Plan (proposed — needs owner approval)

### Policy (Phase 0 — the actual deliverable to ratify)

1. **Every new suppression must carry a reason** using the ESLint-native suffix:
   `// eslint-disable-next-line <rule> -- <reason, ticket ref if debt>`.
2. Enforce with `@eslint-community/eslint-plugin-eslint-comments`:
   - `eslint-comments/require-description` (`error`, for `directive: all`) — the core gate.
   - `eslint-comments/no-unlimited-disable` (`error`) — ban ruleless `/* eslint-disable */`.
   - `eslint-comments/no-unused-disable` (`error`) — suppressions that no longer suppress
     anything get deleted for free.
3. Add to the shared flat presets in `packages/config-eslint/flat/` with overrides OFF for
   `packages/ui/src/components/registries/**` (vendored) and `apps/ui-playground/**`
   (deprecated).
4. **Grandfathering decision (owner call, pick one):**
   - (a) Flip `require-description` on immediately — 824 instant violations, tolerable in
     `packages/*` only because of `only-warn`, but `apps/api` (122) would break CI; or
   - (b) Enable per-package as each remediation phase completes (recommended); or
   - (c) Enable repo-wide at `warn`, promote to `error` per package after remediation.

### Remediation phases (each phase = its own follow-up ticket, fix-vs-justify per rule family)

| Phase | Scope | Approach | Est. size |
|---|---|---|---|
| 1 | `no-restricted-imports`/`no-restricted-syntax`/`no-console` everywhere | Highest review value, tiny count. Fix (route through sanctioned pattern) or justify each with a reason naming the sanctioned exclusion (e.g. the TASK-311 AC-8 list) | ~26 sites |
| 2 | `turbo/no-undeclared-env-vars` | Mostly FIX: declare the var in `turbo.json#globalEnv` (+ `.env.example`) and delete the suppression; justify the remainder (test-only vars) | 66 sites |
| 3 | `@typescript-eslint/no-unused-vars` | Mechanical FIX: delete or `_`-prefix; near-zero risk | 128 sites |
| 4 | `apps/api` residue (any rule) | Bring apps/api to zero bare suppressions, then flip `require-description` to `error` there — locks the hard-error surface first | ~122 sites (overlaps 1–3) |
| 5 | `no-explicit-any` in `packages/domains` + `packages/applications` | Bulk of the debt. Triage per cluster: Prisma/DMMF boundary types get a standard justification string; app-logic `any` gets typed. NOT a single mass edit — batch by service folder with tests green per batch | ~530 sites |
| 6 | Long tail (`agentic-sdk-v2`, ui, stt, med-ner, misc rules) + flip rule to `error` repo-wide | Sweep + closure | ~80 sites |

Verification per phase: `pnpm lint` clean (treating `only-warn` warnings as errors per
`01-development-workflow.md`), affected package tests green, no behavior changes.

### Explicitly out of scope for the whole track

- `packages/ui/src/components/registries/**` (vendored third-party code — suppressions stay).
- `apps/ui-playground` (deprecated, no development plan — 92 sites intentionally left).
- Any change to what the underlying rules allow (no loosening `no-explicit-any` etc.).

## Open Questions

Resolved — see "Owner Decisions" above.

## Implementation Summary

Re-scoped counts on execution start differed from the original inventory once the plan was
actually run against ESLint's own config resolution (not just glob-matched by hand): a large
share of the "827 bare comments" were **inert** — the rule they named was never active on that
exact file (ignored path, an explicit `rule: 'off'` override for that package, or the rule not
configured for that preset at all, e.g. `no-console`/`no-new`/`no-implied-eval` are not enabled
anywhere outside `apps/admin-console`). Two independent methods confirmed this: manual
glob-matching against every package's `ignores`/rule-override blocks, and asking ESLint itself
via `eslint --print-config <file>` for the resolved severity of the exact flagged rule. Of 724
in-scope code-file sites, **331 were dead** (inert, safe to delete outright) and **393 were real**
(the rule was genuinely suppressing something).

### Phase 0 — Policy infra (DONE)

- Added `@eslint-community/eslint-plugin-eslint-comments` to `packages/config-eslint`.
- `flat/core.js` (spread by `library.js`/`nestjs.js`/`react-library.js`) and `flat/next.js`
  (self-contained) both now run `eslint-comments/require-description` (`warn`),
  `no-unlimited-disable` (`error`), `no-unused-disable` (`warn`).
- `packages/ui/src/components/registries/**` gets `require-description: 'off'` (vendored,
  never hand-edited). `apps/ui-playground` is left at the repo-wide `warn` — non-blocking, and
  the app has no development plan, so a permanent lint ignore wasn't worth adding.

### Dead-comment sweep (331 removed, no phase number — cross-cutting)

Removed via a script with a hard safety check (abort file-write if the targeted line doesn't
literally contain `eslint-disable-next-line`), verified in two independent passes plus a live
lint run per touched package (0 new errors) before keeping each batch:

- Ignored-path sites (`**/generated/**`, `**/__tests__/**`, etc.) — 289 (net, after reverting 3
  false positives in `packages/config-eslint/flat/core.js` — that file's OWN prose describes the
  escape-hatch syntax as example text, which a naive "package has no lint script" rule
  misclassified as dead; corrected in the classifier and reverted).
- `packages/database`, `packages/tools`, `packages/eslint-plugin-arcaai-internal` have no
  `lint` script at all (confirmed via `package.json`) — every disable comment inside them was
  inert; 11 sites removed.
- `no-console` (6), `no-new` (1), `no-implied-eval` (1) — confirmed via `eslint --print-config`
  that these rules are not enabled for the flagged file at all; 8 sites removed.
- 11 `turbo/no-undeclared-env-vars` sites whose referenced var was already in
  `turbo.json#globalEnv` at the time (declared for a different call site, disable never removed)
  — confirmed by temporarily deleting the line and re-linting before keeping the removal.

### Phase 1 — no-restricted-imports/syntax/no-console (DONE — turned out to be N/A)

Zero real sites existed: the only matches were `core.js`'s own rule-definition prose describing
the escape hatch, not actual suppressions. The 6 real-looking `no-console` sites were all dead
(see above) and removed in the sweep instead.

### Phase 2 — turbo/no-undeclared-env-vars (DONE — 52 real sites)

- 50 fixed by declaring the referenced var in `turbo.json#globalEnv` (39 new vars) and
  backfilling `.env.example` for the dozen that weren't already documented there.
- 2 justified with `-- reason` instead of declaring: `npm_package_version`
  (`apps/api/src/modules/health/health.controller.ts`) — npm/pnpm-injected, not a configurable
  input; `NO_COLOR` (`apps/api/src/main.ts`) — the code **writes** this convention var to steer
  a third-party logger, it doesn't read external config.
- Every "declare" candidate was verified by temporarily removing the disable line and
  re-linting (no warning fired) before keeping the removal, catching a real bug in an early
  cross-reference pass (a line referencing two vars, only one of which had been checked).

### Phase 3 — no-unused-vars (IN PROGRESS — 87 sites, delegated to background agent)

Dispatched to a subagent with the house convention (rename to `_`-prefixed name when the
parameter is interface-required per `argsIgnorePattern: '^_'` etc. in `flat/core.js`; delete
when genuinely dead) and a mandatory no-`--fix` + per-file lint verification requirement.
Awaiting completion + review.

### Phase 4 — apps/api residue + flip to `error` (PENDING — blocked on Phases 3/5/6 clearing apps/api)

### Phase 5 — no-explicit-any (PENDING — ~259 real sites, the bulk of the remaining debt)

Re-verified count differs from the original ~530 estimate: `packages/ui` turns
`no-explicit-any` off package-wide already (pre-existing override, unrelated to this ticket),
and 63 of the 99 `packages/domains` sites were inside `**/generated/**` (already unlinted, swept
as dead above). Planned as parallel batches partitioned by non-overlapping directory (logging/
observability, auth/authorization/interceptors, audit trail, STT/streaming pipeline,
consultation/misc services, domains+SDK packages), each batch instructed to type where a
concrete correct type is verifiable via `tsc --noEmit`, and to justify (not guess) where `any`
is structurally required (Prisma `Json` columns, third-party callback shapes, generic-erasure
boundaries).

### Phase 6 — long tail (IN PROGRESS — 14/20 sites done)

Done: `no-require-imports` (2 — both justified, CJS interop/browser-bundling constraints),
`no-empty-object-type` (6 — all converted empty `interface X extends Y {}` to `type X = Y`,
verified with `tsc --noEmit`), `no-unsafe-function-type` (1 — justified, `ClassDecorator`'s
generic signature requires the broad `Function` type contravariantly; a narrower constructor
type failed `tsc`), `prettier/prettier` (1 — reformatted, matches Prettier's own output),
`ban-ts-comment` (4 of 10 — justified with the existing inline rationale). Remaining 6
`ban-ts-comment` sites are all in `packages/applications/.../monitoring.service.ts`, which
Phase 3's background agent may also be editing — deferred until Phase 3 lands to avoid a
concurrent-edit collision on the same file.

## Change History

| Date | Change |
|---|---|
| 2026-07-21 | Ticket created from the TASK-536 comment-debt inventory. Counts re-verified (1,744 total / 848 bare / 824 outside vendored), policy + 6-phase remediation plan proposed. Status: Pending (awaiting owner ratification of policy + grandfathering choice). |
| 2026-07-21 | Owner asked for full execution in-ticket. Ratified the three open questions (see Owner Decisions). Phase 0 shipped. Re-verification via `eslint --print-config` (not just hand-modeled glob matching) found 331 of the original 724 in-scope sites were already dead/inert; removed. Phases 1–2 complete, Phase 3 delegated to a background agent, Phase 6 14/20 done. Status: In Progress. |
| 2026-08-12 | Closed — remaining phases (4-6) deprioritized; not being pursued further at this time. |
