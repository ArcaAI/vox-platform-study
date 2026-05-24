import { defineConfig } from 'tsup';

/**
 * TASK-300 C-XCUT-2 / C-XCUT-3:
 *
 * - No `"use client"` banner: `@arcaai/pipeline` contains zero React
 *   imports (verified via grep). It's pure orchestration logic safe to
 *   import from React Server Components.
 * - Emit ESM as `.mjs` (CJS as `.cjs`) for unambiguous resolution
 *   regardless of the host package's `type` field — matches the
 *   convention used by `@arcaai/stt` and `@arcaai/vox`.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  treeshake: true,
  skipNodeModulesBundle: true,
  noExternal: ['eventemitter3'],
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
});
