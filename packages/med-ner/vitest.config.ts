import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'e2e'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', 'e2e', '**/*.test.ts', '**/*.test.tsx', 'vitest.setup.ts'],
    },
    deps: {
      inline: [/@testing-library/],
    },
  },
});
