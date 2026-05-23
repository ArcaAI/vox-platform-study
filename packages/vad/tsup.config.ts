import { defineConfig } from 'tsup';

// TASK-271 (C-3 / C-4): the custom `vad-worklet-processor` was dead code —
// the production path uses `@ricky0123/vad-web`'s internal worklet bundle.
// Only the main entry is built; the separate `dist/worklets/` build was
// removed alongside the source.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@arcaai/room', 'react', '@ricky0123/vad-web', 'onnxruntime-web'],
  treeshake: true,
  minify: false,
  target: 'es2022',
  outDir: 'dist',
});
