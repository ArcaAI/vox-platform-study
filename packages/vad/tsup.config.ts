import { defineConfig } from 'tsup';

/**
 * TASK-271 (C-3 / C-4): the custom `vad-worklet-processor` was dead code —
 * the production path uses `@ricky0123/vad-web`'s internal worklet bundle.
 * Only the main entry is built; the separate `dist/worklets/` build was
 * removed alongside the source.
 *
 * TASK-300 C-XCUT-2: the main entry exports the React hook `useVAD` so the
 * bundle is marked `"use client"` for Next.js App Router compatibility.
 *
 * TASK-300 C-XCUT-3: emit ESM as `.mjs` (CJS as `.cjs`) so consumers get
 * unambiguous resolution regardless of host `type` field, matching the
 * convention used by `@arcaai/stt` and `@arcaai/vox`.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: ['@arcaai/room', 'react', '@ricky0123/vad-web', 'onnxruntime-web'],
    treeshake: true,
    minify: false,
    target: 'es2022',
    outDir: 'dist',
    outExtension({ format }) {
      return { js: format === 'esm' ? '.mjs' : '.cjs' };
    },
    esbuildOptions(options) {
      options.banner = {
        js: '"use client";',
      };
    },
  },
  // TASK-300 C-XCUT-2: react-server stub (ESM-only).
  {
    entry: { 'react-server-stub': 'src/react-server-stub.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    minify: false,
    target: 'es2022',
    outDir: 'dist',
    outExtension() {
      return { js: '.mjs' };
    },
  },
]);
