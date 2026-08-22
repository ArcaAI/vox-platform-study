/**
 * Admin-console E2E configuration.
 *
 * Specs run against an ALREADY-RUNNING stack and skip (not fail) when it is
 * absent — see tests/e2e/helpers/stack.ts:
 *   1. `pnpm dev:api`   — gateway on :8868 with a seeded database
 *   2. `pnpm dev:admin` — this app on :5176
 *   3. `pnpm --filter @arcaai/admin-console test:e2e`
 *
 * Override targets with ADMIN_CONSOLE_URL / API_URL; seeded credentials with
 * E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD.
 */

import { defineConfig, devices } from '@playwright/test';

// Mirror the root playwright.config.ts convention: `.env.test` sets CI=false,
// so the flag must be parsed, never truthiness-coerced.
const isCI = ['1', 'true'].includes((process.env.CI ?? '').toLowerCase());

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Locally the suite runs against `next dev`, which compiles routes on first
  // visit from a SINGLE process. Playwright's default fans out ~cpus/2 workers
  // (8 on a 16-core box) onto that one server, and first-visit compiles then
  // blow the 30s test timeout: measured 33 timeouts at the default vs 1 failure
  // at --workers=2 over the same specs, and tenants.spec.ts went 8 timeouts ->
  // 15/15 passing when run alone. Cap it. CI keeps 1 (and builds the console).
  workers: isCI ? 1 : Number(process.env.PLAYWRIGHT_WORKERS ?? 3),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/html' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.ADMIN_CONSOLE_URL ?? 'http://localhost:5176',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Logs in ONCE and persists the session — the gateway login route is
    // throttled (5/60s), so per-test UI logins trip the rate limiter.
    { name: 'setup', testMatch: '**/auth.setup.ts' },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'test-results/.auth/admin.json',
      },
      dependencies: ['setup'],
    },
  ],
  outputDir: 'test-results/artifacts',
  preserveOutput: 'failures-only',
});
