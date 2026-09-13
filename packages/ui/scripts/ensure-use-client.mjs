/**
 * Prepend `"use client";` to every JS bundle tsup emits.
 *
 * ## Why this exists rather than the esbuild banner alone
 *
 * `tsup.config.ts` asks esbuild for `banner: { js: '"use client";' }`, and esbuild honours it —
 * but `treeshake: true` makes tsup run every emitted chunk back through ROLLUP
 * (`src/plugins/tree-shaking.ts`: `renderChunk` → `rollup()` → `bundle.generate()`), and that
 * `generate()` call passes no `banner` of its own. Rollup treats a top-level string-literal
 * expression statement as side-effect-free and drops it, so the directive never reaches disk.
 *
 * Measured on tsup 8.5.1: with `treeshake: true`, 0 of the emitted js/mjs files carried the
 * directive; with `treeshake: false`, `index.mjs` began with it. Nothing to do with the esbuild
 * version, and nothing to do with `splitting`.
 *
 * tsup runs user `plugins` BEFORE its own tree-shaking plugin, so this cannot be a tsup plugin —
 * it has to run after tsup exits, which is why it is a step in the package's `build` script.
 *
 * ## Why it matters
 *
 * `@arcaai/ui`'s bare export resolves to this `dist/` barrel, and the barrel pulls in
 * `useLayoutEffect` / `useReducer` / `useSyncExternalStore`. Without the directive, any Server
 * Component that reaches the barrel — including indirectly, via `cn` in `ScreenTemplate` or
 * `StatusFooter` — fails `next build` with an RSC boundary error. The directive is what makes the
 * barrel safe to import from either side.
 *
 * ## Source maps
 *
 * Prepending a line would shift every mapping by one line, so each sibling `.map` gets a leading
 * `;` in its `mappings` field — one empty line group — which restores the alignment exactly.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const DIRECTIVE = '"use client";';
const BUNDLE = /\.(js|mjs|cjs)$/;

/** Already directive-prefixed? Accept either quote style, as a hand-edit or a future tsup might emit. */
function hasDirective(code) {
  return /^\s*(['"])use client\1\s*;?/.test(code);
}

async function* bundles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* bundles(path);
    else if (BUNDLE.test(entry.name)) yield path;
  }
}

let patched = 0;
let already = 0;

for await (const file of bundles(DIST)) {
  const code = readFileSync(file, 'utf8');
  if (hasDirective(code)) {
    already += 1;
    continue;
  }
  writeFileSync(file, `${DIRECTIVE}\n${code}`);

  // Keep the map aligned with the line we just inserted. A `;` in `mappings` terminates a line
  // group, so a leading one prepends an empty first line.
  const mapFile = `${file}.map`;
  try {
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    if (typeof map.mappings === 'string') {
      map.mappings = `;${map.mappings}`;
      writeFileSync(mapFile, JSON.stringify(map));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  patched += 1;
}

// A silent no-op is the failure mode worth guarding: if `dist/` moves or the extensions change,
// this script would "succeed" while every bundle lost its directive again.
if (patched + already === 0) {
  console.error('[ensure-use-client] found no bundles under dist/ — did the build layout change?');
  process.exit(1);
}

console.log(`[ensure-use-client] ${patched} patched, ${already} already had the directive`);
