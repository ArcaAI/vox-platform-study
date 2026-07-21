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
    workers: isCI ? 1 : undefined,
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
