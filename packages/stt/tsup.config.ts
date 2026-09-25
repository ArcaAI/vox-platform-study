import { defineConfig } from 'tsup';

/**
 * @arcaai/stt Build Configuration
 *
 * Build outputs:
 * 1. Main bundle (index.ts): audio capture + backend streaming STT transport
 *
 * TASK-1006 (following TASK-865): the in-browser Whisper worker bundle was
 * removed along with the local provider — the browser never runs a model.
 */

export default defineConfig([
  // Main bundle - capture + backend streaming transport
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    external: ['react', '@arcaai/room'],
    esbuildOptions(options) {
      options.banner = {
        js: '"use client";',
      };
    },
  },

  // React-server stub (ESM-only). Lives as a separate tsup entry so it
  // never picks up the `"use client"` banner from the main bundle.
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
