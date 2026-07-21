import { defineConfig } from 'tsup';

/**
 * @arcaai/room build configuration.
 *
 * The main entry exports React hooks (`useRoom`, `useAudioTrack`, etc.) so
 * the bundle carries the `"use client"` directive for Next.js App Router
 * compatibility.
 *
 * ESM is emitted as `.mjs` (CJS as `.cjs`) so the `package.json#exports` map
 * is unambiguous regardless of the host's `type` field, matching the
 * convention used by `@arcaai/stt` and `@arcaai/vox`.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: ['react'],
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
  // Standalone react-server stub (ESM-only).
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
