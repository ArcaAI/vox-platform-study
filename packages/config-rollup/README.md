# @arcaai/config-rollup

Shared Rollup configuration factory for bundling TypeScript packages in the HOPE monorepo. Exports `createConfig()` (a full CJS bundle pipeline with TypeScript, Babel, minification, and code obfuscation) and `createEntriesFromDirectories()` (multi-entry discovery) from `base.js`.

Last updated: 2026-07-04

## Status

No workspace package currently ships a `rollup.config.*` that imports this package — the bundled packages (`room`, `vad`, `noise-filter`, `stt`, `agentic-sdk-v2`, `ui`) all build with tsup. The package remains a devDependency of the repo root (alongside `rollup ^4`) and is copied in the `apps/api` and `apps/ui-playground` Dockerfiles for workspace installs. Treat it as available-but-dormant infrastructure.

## Exports

`main` points to [base.js](./base.js) (ES module):

```javascript
import { createConfig, createEntriesFromDirectories } from '@arcaai/config-rollup';

export default createConfig({
  input: 'src/index.ts',
  outDir: 'dist',
});
```

### createConfig(options)

| Option | Default | Description |
|---|---|---|
| `input` | required | Entry point(s) |
| `outDir` | required | Output directory (CJS, named exports) |
| `minify` | `true` | Terser minification (skipped when `isDev`) |
| `obfuscate` | `true` | javascript-obfuscator hardening (skipped when `isDev`) |
| `sourceMap` | `true` | Emit source maps |
| `externals` | `[]` | Extra externals (merged with built-in list incl. `node_modules`, `@prisma/client`, `express`, ...) |
| `isDev` | `NODE_ENV === 'development'` | Disables minify/obfuscate |
| `preserveModules` / `preserveModulesRoot` | `false` / `null` | Preserve module structure in output |

Plugin pipeline: `rollup-plugin-node-externals`, `@rollup/plugin-node-resolve`, `@rollup/plugin-commonjs`, `@rollup/plugin-json`, `@rollup/plugin-replace` (`process.env.NODE_ENV`), `rollup-plugin-typescript2` (uses the consumer's `./tsconfig.json`), `@rollup/plugin-babel`, `rollup-plugin-node-builtins`, `rollup-plugin-node-globals`, then conditionally `@rollup/plugin-terser` and `rollup-plugin-obfuscator`. Circular-dependency warnings are suppressed.

### createEntriesFromDirectories(srcDir)

Builds an entry map from `srcDir/index.ts` plus every first-level directory containing an `index.ts` (emitted as `<dir>/index`).

## Notes

- The package ships no type declarations for the factory (JS only); add them if the package is revived for new consumers.
