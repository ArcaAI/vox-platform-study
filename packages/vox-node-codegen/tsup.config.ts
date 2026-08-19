import { defineConfig } from 'tsup';

/**
 * @arcaai/vox-node-codegen build configuration — copied in shape from
 * `packages/vox-codegen/tsup.config.ts`, the repo's precedent for a Node-only
 * build-time CLI that lives beside (never inside) a published SDK package.
 *
 * Two passes:
 *  - `src/index.ts` — the library surface, dual ESM/CJS with declarations, so
 *    the generator can be driven programmatically (which is how its unit tests
 *    drive it) rather than only through the CLI.
 *  - `src/cli.ts` — the `bin` entry. CJS-only, matching the `require.main ===
 *    module` guard at the bottom of `cli.ts`, with a shebang banner.
 *
 * `prettier` is left EXTERNAL (tsup's default for dependencies): it is a real
 * runtime dependency of this build-time tool, and bundling a formatter into
 * the CLI would both bloat it and make the emitted formatting depend on when
 * this package was last built rather than on the installed, lockfile-pinned
 * version.
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
