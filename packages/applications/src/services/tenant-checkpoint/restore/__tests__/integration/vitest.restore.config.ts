import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Runner config for the restore integration suite ONLY.
 *
 * The root `vitest.integration.config.ts` loads `tests/setup/integration.setup.ts`, whose
 * `beforeEach` TRUNCATEs every table in `core` and `public` — it would wipe the seeded isolated
 * test database before each case. This suite owns throwaway tenant ids and cleans up only its own
 * rows, so it runs without that setup file.
 *
 *   HOPE_INTEG_DB=1 npx dotenv -e .env.test -- npx vitest run \
 *     --config packages/applications/src/services/tenant-checkpoint/restore/__tests__/integration/vitest.restore.config.ts \
 *     packages/applications/src/services/tenant-checkpoint/restore/__tests__/integration/reconcile.integration.test.ts
 */
export default defineConfig({
  root: path.resolve(__dirname, '../../../../../../../..'),
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: false } },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/applications/src/services/tenant-checkpoint/restore/__tests__/integration/*.integration.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
