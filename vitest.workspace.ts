import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  // Shared packages with co-located tests
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-domains',
      root: './packages/domains',
      include: ['src/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-applications',
      root: './packages/applications',
      include: ['src/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-logger',
      root: './packages/logger',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-database',
      root: './packages/database',
      include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
      environment: 'node',
    },
  },
  // Browser-focused packages - use jsdom environment
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-noise-filter',
      root: './packages/noise-filter',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-room',
      root: './packages/room',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-stt',
      root: './packages/stt',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-vad',
      root: './packages/vad',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-med-ner',
      root: './packages/med-ner',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-utils',
      root: './packages/utils',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      environment: 'node',
      setupFiles: [],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-pipeline',
      root: './packages/pipeline',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      environment: 'jsdom',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-agentic-sdk-v2',
      root: './packages/agentic-sdk-v2',
      include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
      exclude: ['**/integration/**'],
      environment: 'jsdom',
      setupFiles: ['./src/__tests__/vitest.setup.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'packages-ui',
      root: './packages/ui',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
      environment: 'jsdom',
    },
  },

  // API Gateway - Unit Tests
  {
    extends: './vitest.config.ts',
    test: {
      name: 'api-unit',
      root: './apps/api',
      include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
      exclude: ['tests/integration/**', 'tests/e2e/**'],
      environment: 'node',
    },
  },

  // API Gateway - Integration Tests
  {
    extends: './vitest.config.ts',
    test: {
      name: 'api-integration',
      root: './apps/api',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['./tests/setup/integration.setup.ts'],
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
      testTimeout: 60000,
    },
  },
]);
