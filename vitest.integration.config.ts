import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest Configuration for Integration Tests
 *
 * Integration tests require external services (database, redis, etc.)
 * Run with: pnpm test:integration
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./tests/setup/integration.setup.ts'],
    // Run integration tests sequentially to avoid database conflicts
    pool: 'forks',
    isolate: false,
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@tests': path.resolve(__dirname, './tests'),
      '@arcaai/database': path.resolve(__dirname, './packages/database/src/index.ts'),
      '@arcaai/domains': path.resolve(__dirname, './packages/domains/src/index.ts'),
    },
  },
});
