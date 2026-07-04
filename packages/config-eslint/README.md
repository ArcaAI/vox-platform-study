# @arcaai/config-eslint

Shared ESLint configuration for the HOPE monorepo. The configs use the legacy `.eslintrc` format and are run under ESLint 9 with `ESLINT_USE_FLAT_CONFIG=false` (every consumer's `lint` script sets this). The package also wires in the repo-internal plugin [`eslint-plugin-arcaai-internal`](../eslint-plugin-arcaai-internal/README.md) and ships the shared Prettier config.

Last updated: 2026-07-04

## Exported Configs

| File | Purpose | Current consumers (verified) |
|---|---|---|
| `base.js` | Foundation: `@typescript-eslint` + Prettier + Turbo presets, `arcaai-internal` plugin, architectural guard rules (see below) | `apps/api` |
| `library.js` | `base.js` + `only-warn`, Node env, TS import resolver — for TypeScript library packages | `packages/agentic-sdk-v2`, `applications`, `domains`, `exceptions`, `logger`, `med-ner`, `noise-filter`, `pipeline`, `room`, `stt`, `ui`, `vad`, `apps/ui-playground` (deprecated) |
| `nestjs.js` | `base.js` with relaxed rules (`no-explicit-any` off, jest env) for NestJS apps | none currently |
| `next.js` | `base.js` + Vercel style guide for Next.js apps | none currently |
| `react-internal.js` | `base.js` + browser env for bundled React libraries | none currently |
| `storybook.js` | Standalone config with `plugin:storybook/recommended` | none currently |
| `prettier-base.js` | Shared Prettier options (single quotes, printWidth 150, trailing commas) | root `.prettierrc.js` |

## Architectural Guard Rules in base.js

`base.js` registers the workspace plugin `eslint-plugin-arcaai-internal` and enforces layer boundaries:

- `arcaai-internal/no-controller-direct-prisma` (error) on `**/modules/**/*.controller.ts` — controllers must not touch `this.databaseService.client` (TASK-307 W6.4).
- `arcaai-internal/no-direct-downstream-url-env` (error) on `**/modules/**/*.ts` — downstream service URLs must come from `IConfigService.getConfigValue(...)`, not `process.env` (TASK-310 E-5).
- `no-restricted-syntax` on `**/services/**/*.service.ts` — application services must route data access through domain repositories (TASK-311 AC-8).
- `no-restricted-imports` for `getPlatformAdminPrismaClient_Unscoped` — the unscoped Prisma client bypasses tenant scoping and soft delete (TASK-305 B.5).
- `@typescript-eslint/no-unused-vars` honors the `_`-prefix convention for intentionally unused identifiers.

See [../eslint-plugin-arcaai-internal/README.md](../eslint-plugin-arcaai-internal/README.md) for rule details and escape hatches.

## Usage

Consumers create a legacy-format `.eslintrc.js` (or `.eslintrc.cjs`) that extends a config by absolute resolution — real example from `packages/domains/.eslintrc.js`:

```javascript
/** @type {import("eslint").Linter.Config} */
module.exports = {
    root: true,
    extends: [require.resolve("@arcaai/config-eslint/library.js")],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        project: true,
    },
    ignorePatterns: ["dist/", ".turbo/", "node_modules/", "**/__tests__/"],
};
```

The `lint` script must disable flat config, e.g. from `packages/domains/package.json`:

```json
{
  "scripts": {
    "lint": "ESLINT_USE_FLAT_CONFIG=false eslint ."
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

- The package pins `eslint ^8.57.1` as its own devDependency; consumers install ESLint 9 and rely on `ESLINT_USE_FLAT_CONFIG=false` for legacy-format support.
