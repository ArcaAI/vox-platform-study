import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Set jsdom environment for browser-focused packages
    environmentMatchGlobs: [
      ['packages/med-ner/**/*.test.ts', 'jsdom'],
      ['packages/stt/**/*.test.ts', 'jsdom'],
      ['packages/vad/**/*.test.ts', 'jsdom'],
      ['packages/noise-filter/**/*.test.ts', 'jsdom'],
      ['packages/room/**/*.test.ts', 'jsdom'],
      ['packages/pipeline/**/*.test.ts', 'jsdom'],
      ['packages/agentic-sdk-v2/**/*.test.ts', 'jsdom'],
    ],
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/*.e2e-spec.ts',
      '**/integration/**',
      '**/*.integration.ts',
      'apps/ui-playground/**',
    ],
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Only collect coverage for files that are actually imported during tests
      // The 'all' option would include all files matching include patterns
      // but can cause issues in monorepos
      include: [
        'packages/applications/src/**/*.ts',
        'packages/domains/src/**/*.ts',
        'packages/logger/src/**/*.ts',
        'packages/exceptions/src/**/*.ts',
        'packages/pipeline/src/**/*.ts',
        'packages/agentic-sdk-v2/src/**/*.ts',
        'packages/med-ner/src/**/*.ts',
        'packages/stt/src/**/*.ts',
        'packages/vad/src/**/*.ts',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/index.ts',
        '**/tests/**',
        '**/__tests__/**',
        '**/e2e/**',
        '**/integration/**',
        '**/generated/**',
        '**/*.module.ts',
        '**/main.ts',
        '**/*.config.ts',
        '**/setup/**',
        '**/fixtures/**',
        '**/mocks/**',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'threads',
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
});
