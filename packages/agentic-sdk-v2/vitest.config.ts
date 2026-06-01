import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/integration/**'],
    setupFiles: ['./src/__tests__/vitest.setup.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    // Inline workspace deps so they are transformed from source rather than
    // loaded from (potentially absent) dist builds.
    deps: {
      inline: [/@arcaai\//, /zustand/],
    },
    // Redirect optional/native deps to lightweight test mocks and resolve
    // @arcaai/room from source. Consolidated from the former vitest.config.mts
    // (which Vitest 4 never loaded — vitest.config.ts always took precedence —
    // leaving the .tsx suites that depend on these mocks orphaned).
    alias: {
      'highlight.run': resolve(__dirname, './src/__tests__/mocks/highlight.mock.ts'),
      '@opentelemetry/api': resolve(__dirname, './src/__tests__/mocks/otel.mock.ts'),
      eventemitter3: resolve(__dirname, './src/__tests__/mocks/eventemitter3.mock.ts'),
      '@arcaai/med-ner': resolve(__dirname, './src/__tests__/mocks/med-ner.mock.ts'),
      '@arcaai/room': resolve(__dirname, '../room/src/index.ts'),
    },
  },
});
