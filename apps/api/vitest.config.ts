import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // Vitest 4.1.10 → Vite 8/Oxc: keep NestJS legacy decorators, skip metadata
  // (see packages/applications/vitest.config.ts).
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: false,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.spec.ts', 'src/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    // Provide DATABASE_URL for unit tests that transitively import Prisma
    // (e.g., via @arcaai/applications barrel exports). No actual DB calls are made.
    env: {
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/*.test.ts', '**/*.spec.ts', 'tests/**'],
    },
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
});
