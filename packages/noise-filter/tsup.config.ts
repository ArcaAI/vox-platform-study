import { defineConfig } from 'tsup';

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
