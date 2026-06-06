import { defineConfig } from 'vitest/config';

/**
 * Dedicated Vitest config for the live-Postgres WORM regression guard
 * (`src/__tests__/harness-audit-worm.postgres.test.ts`, TASK-330 Phase 0.2).
 *
 * The standard `@arcaai/database` config (`vitest.config.ts`) and the root
 * `pnpm test:unit` both EXCLUDE `*.postgres.test.ts` because those suites need
 * a live Postgres with the migration applied. This config does the inverse:
 * it INCLUDES only the `*.postgres.test.ts` suites so the WORM enforcement can
 * be exercised on demand against the dev database.
 *
 * Run with:
 *   pnpm --filter @arcaai/database exec vitest run --config vitest.worm.config.ts
 *
 * The test reads `process.env.DATABASE_URL` (falling back to the dev DSN) and
 * self-skips when no live DB / migration is reachable.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.postgres.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: [],
    testTimeout: 30000,
    hookTimeout: 30000,
    // These suites all target the SAME dev database and perform catalog DDL in
    // their hooks (CREATE ROLE / GRANT USAGE ON SCHEMA core / REVOKE …). Running
    // the files in parallel races on the shared `core` namespace ACL tuple and
    // raises "tuple concurrently updated", so run them sequentially.
    fileParallelism: false,
  },
});
