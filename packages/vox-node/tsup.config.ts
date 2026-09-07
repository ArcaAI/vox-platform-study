import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

/**
 * The published version, read from this package's own manifest and substituted
 * into the bundle as `__VOX_NODE_VERSION__` (see `src/core/version.ts`). Derived
 * rather than hand-maintained: the literal it replaces already drifted once, and a
 * wrong `User-Agent` is discovered only mid-incident.
 */
const { name, version } = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { name: string; version: string };
if (name !== '@arcaai/vox-node') {
  // tsup runs with the package root as cwd. If it ever does not, stamping some
  // other manifest's version into the bundle is worse than failing the build.
  throw new Error(`tsup.config.ts read ${name}'s package.json, not @arcaai/vox-node's (cwd ${process.cwd()})`);
}

/**
 * @arcaai/vox-node build configuration.
 *
 * Non-browser, server-side SDK: single entry point, ESM-first dual build
 * (ESM + CJS) targeting Node >= 22. Zero runtime dependencies — only global
 * `fetch`/`AbortSignal`/Web Crypto/`ReadableStream` are used, so nothing needs
 * to be marked external beyond tsup's default (dependencies/peerDependencies
 * in package.json are excluded from the bundle automatically; there are none
 * to bundle here).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  target: 'node22',
  platform: 'node',
  clean: true,
  treeshake: true,
  define: {
    // Folds `typeof __VOX_NODE_VERSION__` to `"string"`, so `core/version.ts`'s
    // manifest-reading branch — and with it the `node:fs`/`node:path` imports —
    // is dead-code-eliminated out of the shipped bundle. `check:exports` and the
    // build-output assertion in `core/__tests__/sdk-version.test.ts` hold that.
    __VOX_NODE_VERSION__: JSON.stringify(version),
  },
});
