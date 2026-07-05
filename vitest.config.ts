import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import path from 'path';

const SHARED_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/e2e/**',
  '**/*.e2e-spec.ts',
  '**/integration/**',
  '**/*.integration.ts',
  'apps/ui-playground/**',
  // Infra-dependent suites with their own runners — not part of `test:unit`.
  // PgBouncer rig runs via `pnpm pgbv:test` (needs the pooler on :6532);
  // *.postgres.test.ts is a live-Postgres regression guard.
  '**/pgbouncer-validation/**',
  '**/*.postgres.test.ts',
];

const ADMIN_CONSOLE_SRC = path.resolve(__dirname, './apps/admin-console/src');
const UI_SRC = path.resolve(__dirname, './packages/ui/src');

/**
 * Importer-aware `@/` resolution for the admin-console project — mirrors the
 * plugin in `apps/admin-console/vitest.config.ts` (files inside packages/ui/src
 * resolve `@/` against the UI package root; app files against the app src).
 * Scoped here to admin-console/ui importers only so it cannot affect any other
 * workspace suite. (Typed structurally — the root workspace has no direct
 * `vite` dependency to import the `Plugin` type from.)
 */
function adminConsoleAtAlias() {
  const extensions = ['.tsx', '.ts'];
  return {
    name: 'arcaai-admin-console-at-alias',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (!source.startsWith('@/') || !importer) return undefined;
      if (!importer.startsWith(ADMIN_CONSOLE_SRC) && !importer.startsWith(UI_SRC)) return undefined;
      const base = importer.startsWith(UI_SRC) ? UI_SRC : ADMIN_CONSOLE_SRC;
      const stem = join(base, source.slice(2));
      if (existsSync(stem) && statSync(stem).isFile()) return stem;
      for (const ext of extensions) {
        const candidate = `${stem}${ext}`;
        if (existsSync(candidate)) return candidate;
      }
      for (const ext of extensions) {
        const candidate = join(stem, `index${ext}`);
        if (existsSync(candidate)) return candidate;
      }
      return undefined;
    },
  };
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: SHARED_EXCLUDE,
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    // Two projects: the monorepo-wide node suite, and the admin-console app's
    // node-side (.test.ts) suites. The admin-console files need the app's `@/`
    // alias, its `server-only` stub and its test env (see the app's own
    // vitest.config.ts, used by `pnpm --filter @arcaai/admin-console test`,
    // which additionally runs the browser-side .test.tsx suites) — none of
    // which may leak into the rest of the workspace.
    projects: [
      {
        extends: true,
        test: {
          name: 'workspace',
          exclude: [...SHARED_EXCLUDE, 'apps/admin-console/**'],
        },
      },
      {
        // Deliberately NOT `extends: true`: inherited array options (include/
        // exclude) CONCATENATE with the project's own, which would make this
        // project match the whole workspace again (double-running every
        // suite). Everything this project needs is declared explicitly.
        plugins: [adminConsoleAtAlias()],
        resolve: {
          alias: {
            // `server-only` throws outside a React Server environment; the
            // server modules are exercised directly, so stub it out (same
            // stub the app's own config uses).
            'server-only': path.resolve(__dirname, './apps/admin-console/src/test/stubs/server-only.ts'),
          },
        },
        test: {
          name: 'admin-console',
          globals: true,
          environment: 'node',
          include: ['apps/admin-console/src/**/*.test.ts'],
          exclude: SHARED_EXCLUDE,
          setupFiles: ['./apps/admin-console/src/test/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: 'threads',
          // The app-local run (no .env.test) gets these from its setup file's
          // `??=` defaults; the root run loads .env.test first (API_URL=
          // http://localhost:8868), so force the values the suites are
          // written against — scoped to this project's workers only.
          env: {
            API_URL: 'http://gateway.test:8868',
            ADMIN_SESSION_SECRET: 'vitest-admin-session-secret-0123456789abcdef',
          },
        },
      },
    ],
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
      // Resolve the actively-developed @arcaai/applications package from source
      // rather than its built ./dist. The direct-vitest path (`test:unit`) does
      // not build first (unlike turbo's `test` task), so an incremental rebuild
      // writing dist/index.js concurrently produced "Failed to resolve entry for
      // package" races. Source resolution removes that dependency on build state
      // and matches the coverage config, which already targets packages/*/src.
      '@arcaai/applications': path.resolve(__dirname, './packages/applications/src/index.ts'),
    },
  },
});
