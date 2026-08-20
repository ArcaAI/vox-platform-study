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
    // Claude Code spins up throwaway repo copies under `.claude/worktrees/` for
    // isolated background agents. They are untracked scratch and (usually) lack
    // resolved deps, so scanning them double-counts every suite and fails on
    // ERR_MODULE_NOT_FOUND. Never a real source root — exclude from discovery.
    // (Anchored, not `**/.claude/**`: a leading `**` glob does not descend into
    // hidden `.`-prefixed dirs in the exclude matcher.) Mirrors vitest.config.ts.
    // The three trailing dirs are the owner-directed test-scope exclusions
    // (`.claude/rules/01-development-workflow.md` §Test Scope Exclusions) —
    // out of every aggregate suite, run only via their own package script.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'packages/ui/**', 'apps/compat-playground/**', 'apps/quick-compat-app/**'],
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
