import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

/**
 * Copy `rnnoise.wasm` from the `@jitsi/rnnoise-wasm` package into:
 *   - `assets/rnnoise.wasm`          (package root, consumed via `import.meta.url`)
 *   - `dist/assets/rnnoise.wasm`     (mirror for the bundled output)
 *
 * Both locations are referenced by `package.json` and downstream consumers.
 */
function syncWasmAsset(): void {
  const upstream = require_.resolve('@jitsi/rnnoise-wasm/dist/rnnoise.wasm');
  const targets = [resolve(here, 'assets/rnnoise.wasm'), resolve(here, 'dist/assets/rnnoise.wasm')];
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(upstream, target);
  }
}

/**
 * The main entry exports the React hook `useNoiseFilter` so the bundle is
 * marked `"use client"` for Next.js App Router compatibility.
 *
 * Main-entry ESM is emitted as `.mjs` (and CJS as `.cjs`). The worklet entry
 * keeps its `.js` extension because `audioWorklet.addModule` loads via URL
 * (not a package import) and changing the extension would break consumers'
 * import paths.
 */
export default defineConfig([
  // Main entry point — main thread, exports React hook
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: ['@arcaai/room', 'react'],
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
    onSuccess: async () => {
      syncWasmAsset();
    },
  },
  // AudioWorklet entry — runs in worklet context, no React, side-effects
  // (registers a processor). Extension stays `.js` to keep the loader URL
  // path stable for downstream consumers.
  {
    entry: ['src/worklets/rnnoise.worklet.ts'],
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: false,
    target: 'es2022',
    outDir: 'dist/worklets',
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
