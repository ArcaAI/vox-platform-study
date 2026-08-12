import { defineConfig } from 'tsup';

/**
 * @arcaai/vox-codegen build configuration.
 *
 * Node-only CLI + a small library entry (for testability / programmatic
 * reuse) — the opposite platform target from `@arcaai/vox` itself, which is
 * why this codegen tool lives in its own package rather than a new tsup
 * entry inside `packages/agentic-sdk-v2` (every existing entry there is
 * `platform: 'browser'`; see the package README's placement decision).
 *
 * Two build passes:
 *  - `src/index.ts` — the library surface (fetch + typegen + orchestration),
 *    dual ESM/CJS with declarations, for anything that wants to call this
 *    programmatically instead of shelling out.
 *  - `src/cli.ts` — the `bin` entry. CJS-only (matches how `require.main ===
 *    module` gates the auto-run at the bottom of `cli.ts`) with a shebang
 *    banner; no declarations needed for an executable.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'node22',
    platform: 'node',
    clean: true,
    treeshake: true,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['cjs'],
    dts: false,
    sourcemap: true,
    target: 'node22',
    platform: 'node',
    treeshake: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
