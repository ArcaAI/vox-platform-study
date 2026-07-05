# TASK-418 — Full ESLint 9 Flat-Config Migration

- **Status**: Completed
- **Type**: infrastructure — monorepo-wide lint modernization
- **Created**: 2026-07-04
- **Origin**: TASK-415 review (user decision 2026-07-04: "full migration first" — prioritized before/alongside the admin-console screen phases)

## Requirement Analysis

Migrate the entire monorepo from the legacy ESLint v8 eslintrc estate to ESLint 9 flat config, so the additive `packages/config-eslint/next-flat.js` preset (created for `apps/admin-console` in TASK-415 Phase 1) becomes the norm rather than the exception.

Acceptance criterion: **rule parity** — per-package lint output captured before and after the migration must show zero NEW violations and zero silently-dropped rules. Pre-existing violations stay visible (they are NOT fixed as part of this ticket). The only-warn-in-`packages/*` / hard-errors-in-`apps/api` severity semantics must be preserved exactly.

## Current State Evaluation (inventory, verified 2026-07-05)

### Consumers

15 lint scripts exist (root `pnpm lint` = `turbo run lint`). 14 run legacy eslintrc configs under ESLint 9.39.4 with `ESLINT_USE_FLAT_CONFIG=false`; 1 (`apps/admin-console`) is already flat.

| Package | Config file | Extends | Lint script (pre-migration) |
|---|---|---|---|
| `apps/api` | `.eslintrc.js` | `base.js` (hard errors) | `ESLINT_USE_FLAT_CONFIG=false eslint "{src,apps,libs,test}/**/*.ts" --fix` |
| `packages/applications` | `.eslintrc.js` | `library.js` | `… eslint .` |
| `packages/domains` | `.eslintrc.js` | `library.js` (+ no-explicit-any off for repository/databaseServices/autoMappers) | `… eslint .` |
| `packages/exceptions` | `.eslintrc.js` | `library.js` | `… eslint "src/**/*.ts*" --max-warnings 0` |
| `packages/logger` | `.eslintrc.js` | `library.js` | same |
| `packages/stt` | `.eslintrc.js` | `library.js` | same |
| `packages/ui` | `.eslintrc.js` | `library.js` (+ no-explicit-any off) | `… eslint src --max-warnings 0` |
| `packages/med-ner` | `.eslintrc.cjs` | `library.js` (+ no-duplicate-enum-values off for `src/types/index.ts`) | `… eslint "src/**/*.ts*" --max-warnings 0` |
| `packages/noise-filter` | `.eslintrc.cjs` | `library.js` | same |
| `packages/room` | `.eslintrc.cjs` | `library.js` | same |
| `packages/pipeline` | `.eslintrc.cjs` | `library.js` | same |
| `packages/vad` | `.eslintrc.cjs` | `library.js` | same |
| `packages/agentic-sdk-v2` | `.eslintrc.js` | `library.js` | `… eslint src --ext .ts,.tsx` |
| `apps/ui-playground` | `.eslintrc.cjs` | `library.js` (deprecated app) | `… eslint . --ext .ts,.tsx --fix --ignore-path .gitignore` |
| `apps/admin-console` | `eslint.config.mjs` (flat) | `next-flat.js` | `eslint src --max-warnings 0` (ESLint 10 app-local) |

No `eslintConfig` package.json keys exist. No root-level eslint config exists. `ESLINT_USE_FLAT_CONFIG=false` appears only in the 14 lint scripts above (plus docs). CI (`.gitlab/ci/validate.yml` `lint-ts`) runs `pnpm turbo lint` — interface unchanged by this migration. `.gitlab/ci/rules.yml` already watches `packages/config-eslint/**/*`.

### Presets in `packages/config-eslint` (pre-migration)

- `base.js` (eslintrc): tseslint **v7.18** recommended + `plugin:prettier/recommended` + `prettier` + `turbo`, `arcaai-internal` plugin, 3 scoped architecture overrides (controller-Prisma, services no-restricted-syntax, downstream-URL-env), house rules (`no-unused-vars` `_`-prefix convention, TASK-305 `no-restricted-imports`). Consumer: `apps/api`.
- `library.js` (eslintrc): base + `eslint-plugin-only-warn` + node env + React/JSX globals. Consumers: 12 packages + deprecated `apps/ui-playground`.
- `nestjs.js`, `next.js`, `react-internal.js`, `storybook.js` (eslintrc): **zero consumers** (verified; README concurs).
- `next-flat.js` (flat, ESLint 9/10): tseslint v8, @next/eslint-plugin-next, react, react-hooks, prettier-compat. Consumer: `apps/admin-console`.
- `prettier-base.js`: NOT an ESLint config (shared Prettier options; consumed by root `.prettierrc.js`) — out of scope, kept.

### ESLint versions

- Root devDeps: `eslint ^9.39.4` (the binary every legacy lint run uses — verified `node_modules/.bin/eslint --version` → 9.39.4).
- `packages/config-eslint`: `eslint ^8.57.1` devDep (only used for preset resolution + RuleTester pin), `@typescript-eslint/{parser,eslint-plugin} ^7.18.0` (legacy chain), `typescript-eslint ^8.62.1` (flat chain), `eslint-plugin-only-warn ^1.2.1`, `eslint-config-turbo ^2.10.3`, `eslint-plugin-prettier ^5.5.6`, `eslint-config-prettier ^9.1.2`.
- `packages/{applications,domains,exceptions,ui}`: own `eslint ^9.39.4` (+ tseslint v8 pair in three of them).
- `apps/admin-console`: `eslint ^10.6.0` app-local.
- `packages/eslint-plugin-arcaai-internal`: plain CJS rules map, peer `eslint >=8` — rule objects are already flat-compatible; RuleTester pins in `__tests__/*.test.js` use the eslintrc `parserOptions` shape via `@arcaai/config-eslint/node_modules/eslint` (v8) and must be updated when that pin becomes v9.

### only-warn mechanics (must survive)

`eslint-plugin-only-warn` patches `Linter.prototype.verify` of every `eslint` module found in `require.cache` (fallback: its own peer) at module-load time, downgrading non-fatal severity-2 messages to warnings. It is load-order/side-effect based, not rule based → under flat config a plain `require('eslint-plugin-only-warn')` inside the preset has the identical effect. Severity semantics are per-process: `apps/api` (and admin-console) never load it, so their errors stay errors.

### BEFORE baseline (evidence)

Captured 2026-07-05 with each package's exact lint invocation minus `--fix`, plus `-f json`; per-rule aggregation (`/tmp/task418/before`). All 15 lint scripts exit 0 pre-migration.

| Package | Files linted | Findings (rule: count, all severity=warn) |
|---|---|---|
| ui | 613 | — |
| domains | 104 | prettier/prettier: 5 |
| stt | 30 | — |
| med-ner | 15 | — |
| noise-filter | 17 | — |
| exceptions | 26 | — |
| room | 37 | — |
| logger | 1 | — |
| pipeline | 7 | — |
| vad | 12 | — |
| applications | 742 | prettier/prettier: 105, @typescript-eslint/no-unused-vars: 1, turbo/no-undeclared-env-vars: 1 |
| agentic-sdk-v2 | 125 | prettier/prettier: 71 |
| api | 209 | — (0 findings — hard-error surface is clean) |
| ui-playground | 312 | @typescript-eslint/no-explicit-any: 3, @typescript-eslint/no-unused-vars: 1, "Definition for rule react-hooks/exhaustive-deps not found" (stale disable directives): 2 |
| admin-console | 144 | — (flat already; unchanged by migration) |

### tseslint v7 → v8 recommended rule delta (parity mapping)

Moving `base.js` from `plugin:@typescript-eslint/recommended` (v7.18) to `tseslint.configs.recommended` (v8.62) changes the recommended set:

| v7 rule (error) | v8 status | Parity handling |
|---|---|---|
| `ban-types` | removed — split into `no-empty-object-type`, `no-unsafe-function-type`, `no-wrapper-object-types` (all in v8 recommended) | successors cover the same banned types — not a silent drop |
| `no-var-requires` | removed — superseded by `no-require-imports` (v8 recommended) | superset — not a silent drop |
| `no-loss-of-precision` (extension rule) | removed from recommended (deprecated in favor of the base rule) | base rule `no-loss-of-precision: error` re-added explicitly in the flat core (parity shim) |
| — (new in v8) `no-empty-object-type`, `no-unsafe-function-type`, `no-wrapper-object-types`, `no-require-imports`, `no-unused-expressions`, `prefer-namespace-keyword` | added | acceptable only if they introduce ZERO new findings on the current tree (verified in the after-diff below); otherwise per-rule severity shims would be added |

`parserOptions.project: true` set by legacy consumer configs is dropped: no type-aware rule is (or was) enabled anywhere in the estate, so type-program creation was pure overhead (mirrors the `next-flat.js` design decision).

## Implementation Plan

1. **Baseline** (done): capture per-package JSON lint reports + per-rule counts before any change.
2. **Flat preset family** in `packages/config-eslint/flat/` (CJS, mirroring `next-flat.js` conventions):
   - `flat/core.js` — shared foundation translating `base.js` 1:1: global ignores, tseslint v8 recommended, `eslint-plugin-prettier/recommended` (flat), `eslint-config-turbo/flat`, `arcaai-internal` plugin + the 3 scoped architecture rule blocks (same trailing-segment globs — flat `files` globs resolve against the consumer's `eslint.config.mjs` directory, preserving the matching semantics), house rules + `no-loss-of-precision` parity shim.
   - `flat/library.js` — node/TS library surface: core + node globals + React/JSX globals + `only-warn` side-effect require. Consumers: the 12 packages + ui-playground.
   - `flat/react-library.js` — React/browser library surface: library + browser globals (flat successor of the consumer-less `react-internal.js`; provided for family completeness, no consumers yet).
   - `flat/nestjs.js` — NestJS app surface: core + node globals, NO only-warn (hard errors). Consumer: `apps/api`. (The legacy `nestjs.js` relaxations are NOT carried over — they had zero consumers; `apps/api` linted against plain `base.js`.)
   - `flat/next.js` — Next.js app surface: absorbs `next-flat.js` content verbatim. Consumer: `apps/admin-console` (import updated; `next-flat.js` deleted — single source, no duplication).
3. **Plugin port**: add flat-recommended `meta` to `eslint-plugin-arcaai-internal/index.js`; update the two RuleTester pins to the ESLint 9 flat `languageOptions` shape (the `@arcaai/config-eslint/node_modules/eslint` pin becomes v9 after the dependency bump).
4. **Dependencies** (computed up front, ONE root `pnpm install`): in `packages/config-eslint` — eslint `^8.57.1` → `^9.39.4`, drop `@typescript-eslint/{parser,eslint-plugin}` v7 + `@vercel/style-guide` + `eslint-config-next` + `eslint-plugin-storybook` (legacy-preset-only), add `globals`; update `files` array. No other package.json dependency changes.
5. **Consumer migration** (all 14): add `eslint.config.mjs` (preset + per-package ignores/overrides translated from the old `.eslintrc*`), update lint script (drop `ESLINT_USE_FLAT_CONFIG=false`; drop flat-unsupported `--ext` / `--ignore-path` where present, replicating their effect via config `ignores`), delete the `.eslintrc*` file.
6. **Legacy preset removal**: delete `base.js`, `library.js`, `nestjs.js`, `next.js`, `react-internal.js`, `storybook.js`, `next-flat.js` after all consumers are switched. `prettier-base.js` stays.
7. **ui-playground** (deprecated, minimum-touch): thin flat shim on `flat/library.js` + ignores reproducing its `.gitignore` + old ignorePatterns + a `**/*.{js,cjs,mjs,jsx}` ignore replicating the old `--ext .ts,.tsx` file set. Chosen over "leave on legacy eslintrc" because leaving it legacy would force keeping `library.js`+`base.js` (defeating requirement 5) and the shim is ~15 declarative lines.
8. **Verify** (gates): AFTER per-package JSON reports diffed against baseline (zero new violations); `pnpm lint` green; admin-console lint 0 warnings + build canary; `apps/api` deliberate-violation canary proving architecture rules are still hard errors; spot-check that `packages/applications` warnings are unchanged.
9. **Docs**: `packages/config-eslint/README.md` rewrite; `eslint-plugin-arcaai-internal/README.md` wiring/tests sections; `docs/development-patterns-and-standards.md` §1.7/§5.3/§7.8; `docs/development-guide.md` §9; `.cursor/rules/13-nextjs-apps.mdc` next-flat reference (+ rules README changelog); `.cursor/rules/01-development-workflow.mdc` only if wording no longer matches (only-warn semantics are preserved, so likely no change).

## Implementation Summary

Completed 2026-07-05. The entire estate (15 lint surfaces) now runs ESLint 9 flat config; the legacy eslintrc presets, all 14 `.eslintrc*` files, and every `ESLINT_USE_FLAT_CONFIG=false` escape are deleted. Rule parity verified per package: zero new violations, zero dropped findings.

### Preset family (`packages/config-eslint/flat/`)

| Preset | Contents | Consumers |
|---|---|---|
| `core.js` | 1:1 translation of `base.js`: global ignores, `linterOptions.reportUnusedDisableDirectives: 'off'` (eslintrc-default parity), tseslint v8 recommended, `eslint-plugin-prettier/recommended`, `eslint-config-turbo/flat`, `arcaai-internal` plugin + 3 scoped architecture blocks, house rules, parity shims (`no-loss-of-precision: error`, `no-require-imports` with `allowAsImport: true`) | foundation only |
| `library.js` | core + `only-warn` + React/JSX globals | 12 packages + `apps/ui-playground` |
| `react-library.js` | library (reserved surface for React-specific additions) | none yet |
| `nestjs.js` | core, NO only-warn → architecture rules stay hard errors | `apps/api` |
| `next.js` | former `next-flat.js` verbatim (self-contained: tseslint v8, @next/eslint-plugin-next, react, react-hooks, prettier-compat) | `apps/admin-console` |

Each consumer has an `eslint.config.mjs` spreading its preset plus per-package `ignores`/rule overrides translated from the old `.eslintrc*`. Plugin port: `eslint-plugin-arcaai-internal/index.js` gained flat `meta` (name/version); rule objects were already flat-compatible; both RuleTester suites moved to the ESLint 9 `languageOptions` shape and pass:

```text
no-controller-direct-prisma: RuleTester passes (TASK-307 W6.4)
no-direct-downstream-url-env: RuleTester passes (TASK-310 E-5 / AC-5)
```

### tseslint v7 → v8 parity decisions (see mapping table above)

- `no-loss-of-precision` re-added as base rule (extension rule removed from v8 recommended).
- `no-require-imports` configured `allowAsImport: true` — v8's rule otherwise flags `import x = require()` (used in `apps/api/src/main.ts`, `packages/applications/src/common/authenticateJwt.ts`) which v7's `no-var-requires` allowed.
- `reportUnusedDisableDirectives: 'off'` — flat default is `warn`; eslintrc default was off (keeps ui-playground's 2 stale directives from becoming new findings… they already surfaced as "definition not found" warnings, unchanged).
- New v8-recommended rules (`no-empty-object-type`, `no-unsafe-function-type`, `no-wrapper-object-types`, `no-unused-expressions`, `prefer-namespace-keyword`) produce zero findings on the tree — left enabled, no shims needed.
- `parserOptions.project` dropped estate-wide (no type-aware rules were active; lint is faster).

### only-warn / hard-error semantics (preserved exactly)

`eslint-plugin-only-warn` patches `Linter.prototype.verify` at require-time; a plain `require()` in `flat/library.js` reproduces the eslintrc `plugins: ['only-warn']` effect. `flat/nestjs.js` (apps/api) and `flat/next.js` (admin-console) never load it. Proof:

- `packages/applications`: 107 findings before → 107 after, all `severity=warn` (`prettier/prettier` 105, `turbo/no-undeclared-env-vars` 1, `@typescript-eslint/no-unused-vars` 1).
- `apps/api` canary (deliberate `this.databaseService.client` access in a controller, created → linted → deleted):

```text
13:16  error  Controllers must not access `this.databaseService.client` directly (TASK-307 W6.4 / audit C-10). …  arcaai-internal/no-controller-direct-prisma
✖ 9 problems (9 errors, 0 warnings)   — eslint exit code: 1
```

### ui-playground decision

Migrated with a thin flat shim (`eslint.config.mjs` on `flat/library.js` + declarative `ignores` replicating `--ignore-path .gitignore` and the old `--ext .ts,.tsx` file set). Chosen over leaving it on legacy eslintrc because that would have forced keeping `base.js`+`library.js` alive. Its 6 pre-existing warnings are byte-identical before/after.

### Dependency changes (ONE root `pnpm install`)

- `packages/config-eslint`: `eslint ^8.57.1` → `^9.39.4`; removed `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` (v7), `@vercel/style-guide`, `eslint-config-next`, `eslint-plugin-storybook` (all legacy-preset-only); `files` now ships `flat/*` + `prettier-base.js`.
- `packages/{applications,domains,exceptions}`: dropped redundant `@typescript-eslint/{parser,eslint-plugin}` devDeps (presets bring `typescript-eslint` v8).
- No `globals` package added — `no-undef` is off for TS (tseslint recommended), so env/globals blocks are inert; documented rather than depended-on.
- Lockfile delta: −1761/+78 lines, importers touched only for the packages above.

### Verification evidence (all captured 2026-07-05)

1. **Parity diff** (per-package JSON reports, exact legacy invocation minus `--fix` vs new config): all 15 surfaces `identical before/after` — `ALL PACKAGES AT PARITY` (files-linted counts AND per-rule finding counts; artifacts in `/tmp/task418/{before,after2}`).
2. **`pnpm lint --force`**: `Tasks: 29 successful, 29 total — Time: 26.291s` (includes dependency builds; only warnings printed are the pre-existing ui-playground 6).
3. **`pnpm --filter @arcaai/admin-console lint`**: exit 0 with `--max-warnings 0`.
4. **`pnpm --filter @arcaai/admin-console build`**: production build succeeds (canary).
5. **api hard-error canary**: see block above (exit 1, `error` severity, canary file removed afterwards).

### Files changed

- **Created**: `packages/config-eslint/flat/{core,library,react-library,nestjs,next}.js`; 14 consumer `eslint.config.mjs` files.
- **Deleted**: 14 `.eslintrc*` files; `packages/config-eslint/{base,library,nestjs,next,react-internal,storybook,next-flat}.js`.
- **Modified**: 14 consumer `package.json` lint scripts (env prefix / `--ext` / `--ignore-path` removed); `packages/config-eslint/package.json`; `packages/eslint-plugin-arcaai-internal/{index.js,rules/*,__tests__/*,README.md}`; `packages/config-eslint/README.md` (rewritten); `packages/{database,ui}/README.md`; `docs/development-patterns-and-standards.md` (§1.7, §5.3, §5.4, §7.2/7.3, §7.8 struck through as remediated); `docs/development-guide.md` §9; `.cursor/rules/13-nextjs-apps.mdc` + rules README changelog (v6.3.1). `.cursor/rules/01-development-workflow.mdc` untouched — its only-warn caveat is still accurate.
- **Not touched**: CI lint jobs (`pnpm turbo lint` interface unchanged; `.gitlab/ci/rules.yml` already watches `packages/config-eslint/**/*`), `prettier-base.js`, all pre-existing lint findings (parity requirement).

## Change History

| Date | Change |
|---|---|
| 2026-07-04 | Ticket created from the TASK-415 review decision. |
| 2026-07-05 | Status → In Progress. Full estate inventory recorded (15 lint scripts, preset consumer map, version split, only-warn mechanics), BEFORE lint baseline captured per package, v7→v8 recommended parity mapping decided, implementation plan detailed. |
| 2026-07-05 | Status → Completed. Flat preset family shipped, 14 consumers migrated, legacy presets + eslintrc files deleted, ONE root install executed, parity verified (15/15 identical), all gates green (repo lint 29/29, admin-console lint 0 warnings + build canary, api hard-error canary, applications warnings spot-check, RuleTester suites). Docs updated. |
