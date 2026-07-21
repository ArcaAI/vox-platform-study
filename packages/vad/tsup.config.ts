import { defineConfig } from 'tsup';

/**
 * The custom `vad-worklet-processor` is dead code — the production path
 * uses `@ricky0123/vad-web`'s internal worklet bundle. Only the main entry
 * is built; there is no separate `dist/worklets/` build.
 *
 * The main entry exports the React hook `useVAD` so the bundle is marked
 * `"use client"` for Next.js App Router compatibility.
 *
 * ESM is emitted as `.mjs` (CJS as `.cjs`) so consumers get unambiguous
 * resolution regardless of host `type` field, matching the convention used
 * by `@arcaai/stt` and `@arcaai/vox`.
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
  // React-server stub (ESM-only).
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
