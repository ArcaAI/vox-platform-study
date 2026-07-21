/**
 * SDK bundle externalization guard.
 *
 * Regression guard for the local-model "Invalid URL" defect. `@arcaai/stt` and
 * `@arcaai/noise-filter` resolve runtime assets via `new URL(<rel>, import.meta.url)`
 * (the Whisper worker + the RNNoise WASM). When the SDK bundled those ESM
 * sub-packages (`tsup` `noExternal`), esbuild inlined their source and shimmed
 * `import.meta` to `{}`, so the built `dist/index.mjs` contained:
 *
 *   import_meta2 = {};
 *   new URL("../assets/rnnoise.wasm", import_meta2.url)        // → new URL(rel, undefined)
 *   import_meta3 = {};
 *   new URL("./workers/whisper.worker.mjs", import_meta3.url)  // → "Invalid URL" at runtime
 *
 * …and the `workers/`/`assets/` files never landed in the SDK `dist/`. The fix
 * externalizes both packages so they load from their own dist (where
 * `import.meta.url` + the co-located assets are intact).
 *
 * This guard reads the built bundle and asserts the broken inlined patterns are
 * gone and the packages are referenced as external (dynamic) imports. It
 * therefore requires a prior build — turbo's `test` task `dependsOn: ["build"]`,
 * so CI always builds first; locally run `pnpm --filter @arcaai/vox build`.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// `tsc` classifies this package (no `"type": "module"`, `module: NodeNext`) as
// CommonJS output, which forbids `import.meta` (TS1470). `__dirname` is the
// CommonJS-valid equivalent and is provided at runtime by the Vitest node
// environment (same pattern as the sibling `core/__tests__` suites).
const here = __dirname;
const distDir = resolve(here, '../../dist');

// Both ESM entries bundle the plugin packages with the same tsup config, so both
// must stay free of the inlined asset-URL resolution.
const ESM_ENTRIES = ['index.mjs', 'plugins.mjs'];

describe('TASK-364: SDK bundle externalizes asset-owning sub-packages', () => {
  it('has built ESM bundles to inspect (run `pnpm --filter @arcaai/vox build` first)', () => {
    for (const entry of ESM_ENTRIES) {
      expect(existsSync(resolve(distDir, entry)), `${entry} missing — build the SDK first`).toBe(true);
    }
  });

  it.each(ESM_ENTRIES)('%s does NOT inline the RNNoise wasm URL resolution', (entry) => {
    const code = readFileSync(resolve(distDir, entry), 'utf8');
    // Present only if @arcaai/noise-filter source is inlined (the broken case).
    expect(code).not.toMatch(/new URL\(\s*["']\.\.\/assets\/rnnoise\.wasm["']/);
  });

  it.each(ESM_ENTRIES)('%s does NOT inline the Whisper worker URL resolution', (entry) => {
    const code = readFileSync(resolve(distDir, entry), 'utf8');
    // Present only if @arcaai/stt source is inlined (the broken case).
    expect(code).not.toMatch(/new URL\(\s*["']\.\/workers\/whisper\.worker\.mjs["']/);
  });

  it.each(ESM_ENTRIES)('%s keeps @arcaai/stt + @arcaai/noise-filter external (dynamic import preserved)', (entry) => {
    const code = readFileSync(resolve(distDir, entry), 'utf8');
    expect(code).toMatch(/import\(\s*["']@arcaai\/noise-filter["']\s*\)/);
    expect(code).toMatch(/import\(\s*["']@arcaai\/stt["']\s*\)/);
  });
});
