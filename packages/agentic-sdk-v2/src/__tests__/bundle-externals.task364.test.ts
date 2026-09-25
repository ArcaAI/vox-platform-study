/**
 * SDK bundle externalization guard.
 *
 * Regression guard for the local-model "Invalid URL" defect. `@arcaai/stt`
 * used to resolve runtime assets (the Whisper worker) via `new URL(<rel>,
 * import.meta.url)`. When the SDK bundled that ESM sub-package (tsup
 * `noExternal`), esbuild inlined its source and shimmed `import.meta` to
 * `{}`, so the built `dist/index.mjs` contained an unresolvable URL and the
 * worker file never landed in the SDK `dist/`. The fix externalizes the
 * package so it loads from its own dist.
 *
 * TASK-1006 (following TASK-865): the Whisper worker and `@arcaai/noise-filter`
 * (RNNoise) are gone — the browser never runs a model. `@arcaai/stt` no
 * longer resolves any asset via `import.meta.url` (its capture worklet
 * registers via an inline `Blob` module, not a separate file), but it stays
 * `external` in `tsup.config.ts` regardless — a deliberate, conservative
 * choice, not a requirement any more. This guard now pins only that it
 * stays external (loaded via dynamic `import()`, not inlined).
 *
 * This guard reads the built bundle and therefore requires a prior build —
 * turbo's `test` task `dependsOn: ["build"]`, so CI always builds first;
 * locally run `pnpm --filter @arcaai/vox build`.
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

describe('SDK bundle externalizes asset-owning sub-packages', () => {
  it('has built ESM bundles to inspect (run `pnpm --filter @arcaai/vox build` first)', () => {
    for (const entry of ESM_ENTRIES) {
      expect(existsSync(resolve(distDir, entry)), `${entry} missing — build the SDK first`).toBe(true);
    }
  });

  it.each(ESM_ENTRIES)('%s keeps @arcaai/stt external (dynamic import preserved, not inlined)', (entry) => {
    const code = readFileSync(resolve(distDir, entry), 'utf8');
    expect(code).toMatch(/import\(\s*["']@arcaai\/stt["']\s*\)/);
  });

  // The removed packages' names still appear in the bundle as documentation —
  // error messages and comments explaining why a code path now throws (e.g.
  // "@arcaai/med-ner was removed (TASK-1006)"). That is fine; what must be
  // gone is an actual IMPORT/REQUIRE of them.
  it.each(ESM_ENTRIES)('%s does not import the removed @arcaai/vad / @arcaai/noise-filter / @arcaai/med-ner packages', (entry) => {
    const code = readFileSync(resolve(distDir, entry), 'utf8');
    for (const removed of ['@arcaai/vad', '@arcaai/noise-filter', '@arcaai/med-ner']) {
      expect(code).not.toMatch(new RegExp(`(?:import|require)\\(\\s*["']${removed.replace('/', '\\/')}["']`));
      expect(code).not.toMatch(new RegExp(`from\\s+["']${removed.replace('/', '\\/')}["']`));
    }
  });
});
