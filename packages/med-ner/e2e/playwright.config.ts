import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  timeout: 120000, // NER model loading can take time
  expect: {
    timeout: 30000,
  },
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--enable-features=SharedArrayBuffer',
            '--disable-web-security',
          ],
        },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
      },
    },
  ],
  webServer: {
    // TASK-281 — hybrid_wrapper: a tiny ESM wrapper around `http-server`'s
    // programmatic API that injects COOP/COEP headers (required for
    // SharedArrayBuffer / worker-mode) and serves the package root so the
    // fixture's `/dist/...` bundle imports resolve.
    //
    // Playwright defaults `cwd` to the config-file directory (`e2e/`), so
    // we explicitly hop up one level to the package root before invoking
    // the wrapper (which expects to be launched as `node e2e/serve.mjs`).
    command: 'node e2e/serve.mjs',
    cwd: '..',
    url: 'http://127.0.0.1:8080/e2e/fixtures/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
