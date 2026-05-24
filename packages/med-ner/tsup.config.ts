import { defineConfig } from 'tsup';

/**
 * @arcaai/med-ner build configuration.
 *
 * Three outputs:
 *   1. Main bundle (`src/index.ts`) — the public API consumed on the main
 *      thread. Marked `"use client"` for Next.js App Router compatibility.
 *   2. Worker bundle (`src/workers/medner.worker.ts`) — a standalone ESM
 *      file that hosts the NER pipeline. Loaded by consumers via:
 *      `new Worker(new URL('@arcaai/med-ner/dist/workers/medner.worker.js', import.meta.url), { type: 'module' })`.
 *      The worker bundles `@huggingface/transformers` because workers run
 *      in isolation and cannot share imports with the main thread.
 *   3. E2E bundle (`src/index.ts` → `dist/e2e/index.js`) — TASK-289.
 *      A fully-bundled, browser-resolvable variant of the public API used
 *      only by the Playwright fixture at `e2e/fixtures/index.html`. The
 *      consumer-facing main bundle (output #1) intentionally leaves
 *      `react` / `@huggingface/transformers` as bare-specifier imports so
 *      downstream bundlers (Next.js, Vite) can dedupe and tree-shake. Those
 *      bare specifiers cannot be resolved by a raw browser `<script
 *      type="module">` loader, which is exactly what the Playwright fixture
 *      uses. Output #3 inlines them via `noExternal` so the fixture can
 *      load `/dist/e2e/index.js` directly with no importmap and no CDN.
 *      Excluded from the published package via `package.json#files`.
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
    // TASK-300 C-XCUT-3: emit ESM as `.mjs` (CJS as `.cjs`) for unambiguous
    // resolution. Worker / E2E entries keep their `.js` extension since
    // they're loaded via explicit URL paths.
    outExtension({ format }) {
      return { js: format === 'esm' ? '.mjs' : '.cjs' };
    },
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
  {
    entry: { 'e2e/index': 'src/index.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    external: ['@arcaai/room'],
    noExternal: ['react', 'react-dom', '@huggingface/transformers'],
    esbuildOptions(options) {
      options.platform = 'browser';
      options.conditions = ['browser', 'module', 'import', 'default'];
    },
  },
  // TASK-300 C-XCUT-2: react-server stub (ESM-only). Separate entry so it
  // does NOT inherit the `"use client"` banner from the main bundle —
  // RSC bundlers should be able to evaluate it server-side and throw.
  {
    entry: { 'react-server-stub': 'src/react-server-stub.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    minify: false,
    outExtension() {
      return { js: '.mjs' };
    },
  },
]);
