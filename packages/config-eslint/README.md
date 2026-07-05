# @arcaai/config-eslint

Shared ESLint configuration for the HOPE monorepo. Since TASK-418 the package ships an **ESLint 9 flat-config preset family** under `flat/`; the legacy eslintrc presets (`base.js`, `library.js`, ...) and the `ESLINT_USE_FLAT_CONFIG=false` escape are gone. The package also wires in the repo-internal plugin [`eslint-plugin-arcaai-internal`](../eslint-plugin-arcaai-internal/README.md) and ships the shared Prettier config.

Last updated: 2026-07-05

## Exported Configs

| File | Purpose | Current consumers (verified) |
|---|---|---|
| `flat/core.js` | Shared foundation (not an entry point): typescript-eslint v8 recommended, prettier-as-a-rule, turbo, `arcaai-internal` architecture rules, house conventions | spread by the surface presets below |
| `flat/library.js` | core + `eslint-plugin-only-warn` (violations surface as warnings) — for TypeScript library packages | `packages/agentic-sdk-v2`, `applications`, `domains`, `exceptions`, `logger`, `med-ner`, `noise-filter`, `pipeline`, `room`, `stt`, `ui`, `vad`, `apps/ui-playground` (deprecated) |
| `flat/nestjs.js` | core with NO only-warn — architecture rules are HARD ERRORS | `apps/api` |
| `flat/next.js` | Self-contained Next.js preset (tseslint v8, @next/eslint-plugin-next, react, react-hooks, prettier-compat). Formerly `next-flat.js` | `apps/admin-console` |
| `flat/react-library.js` | React-library surface (currently identical to `flat/library.js`; own entry point for future divergence) | none currently |
| `prettier-base.js` | Shared Prettier options (single quotes, printWidth 150, trailing commas) | root `.prettierrc.js` |

## Architectural Guard Rules in flat/core.js

`flat/core.js` registers the workspace plugin `eslint-plugin-arcaai-internal` and enforces layer boundaries:

- `arcaai-internal/no-controller-direct-prisma` (error) on `**/modules/**/*.controller.ts` — controllers must not touch `this.databaseService.client` (TASK-307 W6.4).
- `arcaai-internal/no-direct-downstream-url-env` (error) on `**/modules/**/*.ts` — downstream service URLs must come from `IConfigService.getConfigValue(...)`, not `process.env` (TASK-310 E-5).
- `no-restricted-syntax` on `**/services/**/*.service.ts` — application services must route data access through domain repositories (TASK-311 AC-8).
- `no-restricted-imports` for `getPlatformAdminPrismaClient_Unscoped` — the unscoped Prisma client bypasses tenant scoping and soft delete (TASK-305 B.5).
- `@typescript-eslint/no-unused-vars` honors the `_`-prefix convention for intentionally unused identifiers.

See [../eslint-plugin-arcaai-internal/README.md](../eslint-plugin-arcaai-internal/README.md) for rule details and escape hatches.

## Severity Semantics (do not break)

`flat/library.js` loads `eslint-plugin-only-warn`, which patches the running ESLint's `Linter#verify` and downgrades every non-fatal error to a warning — so in `packages/*` the architecture rules surface as WARNINGS (treat them as errors anyway). `flat/nestjs.js` and `flat/next.js` never load it, so `apps/api` and `apps/admin-console` fail on errors. This is the contract documented in `.cursor/rules/01-development-workflow.mdc`.

## Usage

Consumers create an `eslint.config.mjs` that spreads a surface preset and appends package-local ignores/overrides — real example from `packages/domains/eslint.config.mjs`:

```javascript
import library from '@arcaai/config-eslint/flat/library.js';

export default [
    ...library,
    {
        ignores: ['src/__tests__/**', 'src/integration/**', '**/generated/**', '**/__tests__/**', 'vitest.config.ts'],
    },
    {
        files: ['src/common/repository.ts', 'src/common/databaseServices/**/*.ts', 'src/common/autoMappers/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
];
```

The `lint` script is plain flat-config ESLint (no env escape, no `--ext`), e.g. from `packages/domains/package.json`:

```json
{
  "scripts": {
    "lint": "eslint ."
  }
}
```

The shared Prettier options are consumed by the root `.prettierrc.js`:

```javascript
module.exports = {
    ...require('@arcaai/config-eslint/prettier-base'),
    tabWidth: 2,
};
```

## Notes

- Presets are CJS (`module.exports = [...]`); ESM consumers default-import them (see usage above).
- The core does not enable type-aware linting (`parserOptions.project`) — no type-checked rule is enabled, and skipping the type program keeps lint fast (same decision as the original `next-flat.js`).
- The config file itself is not linted: `**/eslint.config.mjs` is in the shared ignores (the flat analogue of the old `.*.js` pattern that covered `.eslintrc.js`).
- typescript-eslint v7 → v8 recommended deltas and the parity shims (`no-loss-of-precision`, `reportUnusedDisableDirectives: off`) are documented in `flat/core.js` and in the TASK-418 ticket README (with before/after lint evidence).
- The package pins `eslint ^9.39.4` as its own devDependency (RuleTester + resolution); consumers run ESLint 9 (admin-console: ESLint 10 app-local, works against the same flat presets).
