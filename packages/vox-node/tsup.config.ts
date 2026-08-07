import { defineConfig } from 'tsup';

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
});
