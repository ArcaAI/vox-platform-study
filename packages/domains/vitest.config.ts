import { defineConfig } from 'vitest/config';

/**
 * Local Vitest config for `@arcaai/domains`.
 *
 * Mirrors the `packages-domains` project in `vitest.workspace.ts` so that
 * `pnpm --filter @arcaai/domains test` / `turbo test --filter=@arcaai/domains`
 * pick up the same tests as the root-level `pnpm test:unit` does.
 *
 * Wired in so the Postgres regression test
 * (`updateWithVersion.postgres.test.ts`) runs in the GitLab `test-packages`
 * CI job — the permanent guard against Prisma silently breaking OCC on a
 * future driver migration (issues #10207 / #28840).
 */
export default defineConfig({
  // Vitest 4.1.10 → Vite 8/Oxc: keep NestJS legacy decorators, skip metadata
  // (see packages/applications/vitest.config.ts).
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: false,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    // Mirror the monorepo-wide `**/integration/**` exclusion from
    // `vitest.workspace.ts` so `turbo test --filter=@arcaai/domains` only runs
    // unit + lightweight DB-touching tests. The Postgres regression file
    // (`updateWithVersion.postgres.test.ts`) lives in `__tests__/` and
    // self-skips when DATABASE_URL is absent, so it's safe under this filter.
    exclude: ['**/node_modules/**', '**/dist/**', '**/integration/**'],
    // The shared `tests/setup/vitest.setup.ts` lives at the monorepo root; it
    // is wired in through the root `vitest.workspace.ts` for `pnpm test:unit`.
    // When this package is invoked standalone (`turbo test --filter
    // @arcaai/domains`), it must not inherit that path — override to empty.
    setupFiles: [],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
