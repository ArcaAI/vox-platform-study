import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: { resolve: false },
  external: ['@arcaai/types'],
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  tsconfig: './tsconfig.build.json',
});

