import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/integration/**'],
    setupFiles: ['./src/__tests__/vitest.setup.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
