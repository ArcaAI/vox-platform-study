import { defineConfig } from 'tsup';

/**
 * @arcaai/med-ner build configuration.
 *
 * Two outputs:
 *   1. Main bundle (`src/index.ts`) — the public API consumed on the main
 *      thread. Marked `"use client"` for Next.js App Router compatibility.
 *   2. Worker bundle (`src/workers/medner.worker.ts`) — a standalone ESM
 *      file that hosts the NER pipeline. Loaded by consumers via:
 *      `new Worker(new URL('@arcaai/med-ner/dist/workers/medner.worker.js', import.meta.url), { type: 'module' })`.
 *      The worker bundles `@huggingface/transformers` because workers run
 *      in isolation and cannot share imports with the main thread.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: {
      compilerOptions: {
        composite: false,
        incremental: false,
      },
    },
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ['react', 'react-dom', '@arcaai/room'],
    esbuildOptions(options) {
      options.banner = {
        js: '"use client";',
      };
    },
  },
  {
    entry: { 'workers/medner.worker': 'src/workers/medner.worker.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    noExternal: ['@huggingface/transformers'],
    esbuildOptions(options) {
      options.platform = 'browser';
      options.conditions = ['browser', 'module', 'import', 'default'];
    },
  },
]);
