import { defineConfig } from 'vitest/config';

/**
 * Local Vitest config for `@arcaai/database`.
 *
 * Mirrors the subset of the root `vitest.config.ts` that `pnpm test:unit`
 * runs for this package, so `turbo run test --filter=@arcaai/database` (and
 * `pnpm --filter @arcaai/database test`) exercise the SAME unit + script
 * suites the root run does. Until now `@arcaai/database` had no `test` script,
 * so `turbo run test --filter=@arcaai/database` silently skipped the package —
 * the database unit suite only ever ran via the root `pnpm test:unit`. That
 * gap is why a verification command could report "green"
 * without actually running any database test. Mirrors the standalone
 * `@arcaai/domains` config (`packages/domains/vitest.config.ts`).
 *
 * Scope: `src` + `scripts` unit tests. Excludes the infra-dependent suites the
 * root config also keeps out of `test:unit` — `integration/**` (needs a live
 * Postgres), `*.postgres.test.ts` (live-Postgres regression guard) and the
 * PgBouncer rig (`pnpm pgbv:test`, needs the pooler on :6532).
 *
 * Env: `@arcaai/database`'s `src/env.ts` auto-loads `.env.test` on import when
 * `NODE_ENV=test` (Vitest sets this) and `DATABASE_URL` is unset, so the
 * env-sensitive client/env suites get their configuration without dotenv-cli.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/integration/**', '**/*.integration.ts', '**/pgbouncer-validation/**', '**/*.postgres.test.ts'],
    // The shared root setup (`tests/setup/vitest.setup.ts`) only registers
    // browser-API mocks + a `testUtils` global that no `@arcaai/database` suite
    // uses; running standalone must not inherit that path (mirrors the
    // `@arcaai/domains` standalone config).
    setupFiles: [],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
