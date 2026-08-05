import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  timeout: 60000,
  expect: {
    timeout: 15000,
  },
  use: {
    baseURL: 'http://localhost:8082',
    trace: 'on-first-retry',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
    // Firefox and WebKit are OFF by default: `pnpm sdk:setup`/`pnpm install` only
    // provisions Chromium, so enabling them here makes `pnpm test:e2e` fail on
    // missing browsers rather than on anything about the SDK. Run
    // `npx playwright install firefox webkit` and set PLAYWRIGHT_ALL_BROWSERS=1
    // for a genuine cross-browser pass (the suite's "Cross-Browser Compatibility"
    // describe block is written against `browserName`, so it covers whatever runs).
    ...(process.env.PLAYWRIGHT_ALL_BROWSERS
      ? [
          {
            name: 'firefox',
            use: {
              ...devices['Desktop Firefox'],
              launchOptions: {
                firefoxUserPrefs: {
                  'media.navigator.streams.fake': true,
                  'media.navigator.permission.disabled': true,
                },
              },
            },
          },
          {
            name: 'webkit',
            use: {
              ...devices['Desktop Safari'],
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: 'npx http-server ./e2e/fixtures -p 8082 -c-1 --cors',
    url: 'http://localhost:8082',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
