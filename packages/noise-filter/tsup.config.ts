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
 *
 * TASK-269 — CRIT-2.
 */
function syncWasmAsset(): void {
  const upstream = require_.resolve('@jitsi/rnnoise-wasm/dist/rnnoise.wasm');
  const targets = [
    resolve(here, 'assets/rnnoise.wasm'),
    resolve(here, 'dist/assets/rnnoise.wasm'),
  ];
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(upstream, target);
  }
}

export default defineConfig([
  // Main entry point
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: ['@arcaai/room'],
    treeshake: true,
    minify: false,
    target: 'es2022',
    outDir: 'dist',
    onSuccess: async () => {
      syncWasmAsset();
    },
  },
  // AudioWorklet entry (separate build for worklet context)
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
]);
