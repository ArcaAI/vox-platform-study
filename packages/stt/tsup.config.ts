import { defineConfig } from 'tsup';

/**
 * @arcaai/stt Build Configuration
 *
 * Build outputs:
 * 1. Main bundle (index.ts): STT processors, hooks, engines
 * 2. Worker bundle (whisper.worker.ts): Runs Whisper in Web Worker
 *
 * The worker bundle is a separate ESM file that can be loaded via:
 *   new Worker(new URL('./workers/whisper.worker.js', import.meta.url))
 */

export default defineConfig([
  // Main bundle - includes all STT functionality
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

  // Worker bundle - separate file for Web Worker
  // This gets bundled as a standalone file that can be loaded by WhisperWorkerEngine
  {
    entry: {
      'workers/whisper.worker': 'src/workers/whisper.worker.ts',
    },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false, // Don't clean, main build already cleaned
    treeshake: true,
    minify: false,
    // Workers need all dependencies bundled since they run in isolation
    noExternal: ['@huggingface/transformers'],
    esbuildOptions(options) {
      // Worker runs in a worker context, not browser DOM
      options.platform = 'browser';
      options.conditions = ['browser', 'module', 'import', 'default'];
    },
  },
]);
