# @arcaai/config-eslint — shared ESLint flat-config presets

Shared ESLint configuration for the HOPE monorepo: an ESLint 9 flat-config preset family under
`flat/`. The package also wires in the repo-internal plugin
[`eslint-plugin-arcaai-internal`](../eslint-plugin-arcaai-internal/README.md) and ships the shared
Prettier config.

## Layout

| Path | What it holds |
|---|---|
| `flat/core.js` | Shared foundation (not an entry point): typescript-eslint v8 recommended, prettier-as-a-rule, turbo, `arcaai-internal` architecture rules, house conventions |
| `flat/library.js` | core + `eslint-plugin-only-warn` (violations surface as warnings) — for TypeScript library packages |
| `flat/nestjs.js` | core with NO only-warn — architecture rules are HARD ERRORS |
| `flat/next.js` | Self-contained Next.js preset (tseslint v8, `@next/eslint-plugin-next`, react, react-hooks, prettier-compat) |
| `flat/react-library.js` | React-library surface (currently identical to `flat/library.js`; own entry point for future divergence) |
| `prettier-base.js` | Shared Prettier options (single quotes, printWidth 150, trailing commas) |

## How it works

### Current consumers (verified against each package's `eslint.config.mjs`)

| Preset | Consumers |
|---|---|
| `flat/library.js` | `packages/agentic-sdk-v2`, `applications`, `domains`, `exceptions`, `logger`, `med-ner`, `noise-filter`, `pipeline`, `room`, `stt`, `ui`, `vad`, `vox-node`, `vox-codegen`, `vox-node-codegen`, `workflow-contract`, `async-contract`, `json-schema-subset` |
| `flat/nestjs.js` | `apps/api` |
| `flat/next.js` | `apps/admin-console` |
| `flat/react-library.js` | `apps/compat-playground` |

### Architectural guard rules in `flat/core.js`

`flat/core.js` registers the workspace plugin `eslint-plugin-arcaai-internal` and enforces layer
boundaries:

- `arcaai-internal/no-controller-direct-prisma` (error) on `**/modules/**/*.controller.ts` — controllers must not touch `this.databaseService.client`.
- `arcaai-internal/no-direct-downstream-url-env` (error) on `**/modules/**/*.ts` — downstream service URLs must come from `IConfigService.getConfigValue(...)`, not `process.env`.
- `arcaai-internal/require-internal-tenant-header` (error) on `**/src/**/*.ts` (tests excluded) — an outbound internal call sending `X-Service-Token` must also carry a tenant channel.
- `arcaai-internal/require-api-key-justification` (error) on `**/modules/**/*.controller.ts` (tests excluded) — a business-plane `@ForbidApiKey()` must record WHY in an `// API-KEY-NOTE`.
- `no-restricted-syntax` on `**/services/**/*.service.ts` — application services must route data access through domain repositories, with a scoped allow-list (`services/audit/**`, `services/tenant/**`, `services/user/userRoleAssignment/**`, `services/baseServices/**`).
- `no-restricted-imports` for `getPlatformAdminPrismaClient_Unscoped` — the unscoped Prisma client bypasses tenant scoping and soft delete.
- `@typescript-eslint/no-unused-vars` honors the `_`-prefix convention for intentionally unused identifiers.

See [`../eslint-plugin-arcaai-internal/README.md`](../eslint-plugin-arcaai-internal/README.md) for
rule details and escape hatches.

### Severity semantics (do not break)

`flat/library.js` loads `eslint-plugin-only-warn`, which patches the running ESLint's
`Linter#verify` and downgrades every non-fatal error to a warning — so in `packages/*` the
architecture rules surface as WARNINGS (treat them as errors anyway, per
`.claude/rules/01-development-workflow.md`). `flat/nestjs.js` and `flat/next.js` never load it, so
`apps/api` and `apps/admin-console` fail on errors.

### Usage

Consumers create an `eslint.config.mjs` that spreads a surface preset and appends package-local
ignores/overrides — real example from `packages/domains/eslint.config.mjs`:

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

The `lint` script is plain flat-config ESLint (no env escape, no `--ext`), e.g. from
`packages/domains/package.json`:

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

## Gotchas

- Presets are CJS (`module.exports = [...]`); ESM consumers default-import them (see usage above).
- The core does not enable type-aware linting (`parserOptions.project`) — no type-checked rule is
  enabled, and skipping the type program keeps lint fast.
- The config file itself is not linted: `**/eslint.config.mjs` is in the shared ignores.
- The package pins `eslint ^10.10.0` as its own devDependency (`RuleTester` + resolution);
  consumers run whichever ESLint 9/10 their own `package.json` resolves against the same flat
  presets.

## Related

- [`../eslint-plugin-arcaai-internal/README.md`](../eslint-plugin-arcaai-internal/README.md) — the custom rules this package wires in
- [`01-development-workflow.md`](../../.claude/rules/01-development-workflow.md) — the only-warn severity caveat
