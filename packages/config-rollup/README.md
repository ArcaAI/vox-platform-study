# @arcaai/config-rollup — shared Rollup bundle factory (dormant)

Shared Rollup configuration factory for bundling TypeScript packages in the HOPE monorepo. Exports
`createConfig()` (a full CJS bundle pipeline with TypeScript, Babel, minification, and code
obfuscation) and `createEntriesFromDirectories()` (multi-entry discovery) from `base.js`.

## Layout

| Path | What it holds |
|---|---|
| `base.js` | `createConfig()` and `createEntriesFromDirectories()` — the package's `main` entry (ES module) |

## How it works

### Status: available but dormant

No workspace package currently ships a `rollup.config.*` that imports this package — the bundled
packages (`room`, `vad`, `noise-filter`, `stt`, `agentic-sdk-v2`, `ui`) all build with tsup instead.
The package remains a devDependency of the repo root (alongside `rollup ^4`) and is copied in the
`apps/api` Dockerfile for workspace installs. Treat it as available-but-dormant infrastructure, not
dead code to delete casually — it was smoke-tested and kept installable as recently as TASK-936.

### `createConfig(options)`

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

Plugin pipeline: `rollup-plugin-node-externals`, `@rollup/plugin-node-resolve`,
`@rollup/plugin-commonjs`, `@rollup/plugin-json`, `@rollup/plugin-replace`
(`process.env.NODE_ENV`), `rollup-plugin-typescript2` (uses the consumer's `./tsconfig.json`),
`@rollup/plugin-babel`, `rollup-plugin-polyfill-node`, then conditionally `@rollup/plugin-terser`
and `rollup-plugin-obfuscator`. Circular-dependency warnings are suppressed.

```javascript
import { createConfig, createEntriesFromDirectories } from '@arcaai/config-rollup';

export default createConfig({
  input: 'src/index.ts',
  outDir: 'dist',
});
```

### `createEntriesFromDirectories(srcDir)`

Builds an entry map from `srcDir/index.ts` plus every first-level directory containing an
`index.ts` (emitted as `<dir>/index`).

## Gotchas

- `rollup-plugin-node-builtins` and `rollup-plugin-node-globals` were replaced (TASK-936) by their
  maintained successor `rollup-plugin-polyfill-node`, which does both jobs. The old pair was the
  sole source of five security advisories in the repo (2x semver ReDoS, 2x `bl` memory exposure,
  1x `elliptic`), all reached through `rollup-plugin-node-builtins > browserify-fs > levelup` and
  `> crypto-browserify > browserify-sign`. Do not reintroduce either package.
- The package ships no type declarations for the factory (JS only) — add them if it is revived for
  new consumers.

## Related

- [`07-react-ui.md`](../../.claude/rules/07-react-ui.md) — the packages that build with tsup instead of this factory today
