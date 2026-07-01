/**
 * Admin Console — Frontend E2E (Playwright)
 *
 * Browser-driven, FULL-STACK end-to-end tests for the HOPE Admin Console.
 * A spec drives the real UI (Vite dev server on :5174), which calls the real
 * API Gateway (:8868) — so these exercise the frontend → backend path.
 *
 * Three viewport projects encode the approved responsive model (TASK-384 /
 * TASK-371 foundation `07 · Responsive`):
 *   - desktop ≥ 1024 (lg)   — full sidebar + data grids
 *   - tablet 768–1023 (md)  — icon-rail + condensed tables
 *   - mobile < 768          — drawer nav + card-list + FAB
 *
 * RUN (requires a seeded stack — see e2e/README.md):
 *   1. pnpm docker:test:up && pnpm test:db:reset
 *   2. pnpm dev:api:test                      # API on :8868 (separate terminal)
 *   3. npx playwright install chromium        # one-time
 *   4. From repo root:
 *      pnpm exec playwright test --config apps/admin/playwright.config.ts
 *   (webServer below auto-starts `pnpm dev` for the admin app.)
 *
 * DISCOVER WITHOUT RUNNING (no stack needed — used as the authored-spec gate):
 *   pnpm exec playwright test --config apps/admin/playwright.config.ts --list
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ADMIN_E2E_PORT ?? 5174);
const baseURL = process.env.ADMIN_E2E_BASE_URL ?? `http://localhost:${PORT}`;
const isCI = ['1', 'true'].includes((process.env.CI ?? '').toLowerCase());

export default defineConfig({
    testDir: './e2e',
    testMatch: '**/*.spec.ts',
    fullyParallel: true,
    forbidOnly: isCI,
    retries: isCI ? 2 : 0,
    workers: isCI ? 1 : undefined,
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]],
    timeout: 30_000,
    expect: { timeout: 10_000 },
    use: {
        baseURL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },

    // Viewport tiers = the approved Desktop / Tablet / Mobile responsive model.
    // All Chromium so a single `playwright install chromium` covers every tier.
    projects: [
        {
            name: 'desktop',
            use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } },
        },
        {
            name: 'tablet',
            use: { browserName: 'chromium', viewport: { width: 834, height: 1112 }, hasTouch: true },
        },
        {
            name: 'mobile',
            use: { ...devices['Pixel 5'], browserName: 'chromium', viewport: { width: 390, height: 844 } },
        },
    ],

    // Auto-start the admin dev server. The API at :8868 must already be running
    // (the dev server proxies /api → :8868); login fails fast otherwise.
    webServer: {
        command: 'pnpm dev',
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: !isCI,
    },
});
