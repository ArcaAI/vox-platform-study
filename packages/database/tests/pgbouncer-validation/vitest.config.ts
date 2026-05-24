// packages/database/tests/pgbouncer-validation/vitest.config.ts
//
// Self-contained Vitest config for the PgBouncer validation rig
// (TASK-302 Stream C Phase 1).
//
// Kept deliberately separate from the monorepo's root vitest.config.ts so
// that:
//   * `pnpm test:unit` does NOT accidentally pick up these tests
//   * pool=forks single=true ensures serial execution → deterministic
//     `SHOW POOLS` / `SHOW STATS` evidence
//   * no shared `setupFiles` are pulled in (the rig is hermetic)

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    root: __dirname,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    forks: { singleFork: true },
    reporters: ['verbose'],
  },
});
