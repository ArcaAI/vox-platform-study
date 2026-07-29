import { defineConfig, devices } from '@playwright/experimental-ct-react';
import { resolve } from 'path';

/**
 * Playwright Component Testing Configuration for @arcaai/ui
 *
 * This config enables testing React components in isolation using
 * Playwright's component testing capabilities.
 *
 * @see https://playwright.dev/docs/test-components
 */
export default defineConfig({
  // Directory for component tests
  testDir: './src/components/__tests__',

  // Test file patterns
  testMatch: '**/*.test.tsx',

  // Snapshot directory
  snapshotDir: './src/components/__tests__/__snapshots__',

  // Timeout for each test
  timeout: 30000,

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only
  forbidOnly: !!process.env.CI,

  // Retry failed tests in CI
  retries: process.env.CI ? 2 : 0,

  // Number of workers
  workers: process.env.CI ? 1 : undefined,

  // Reporter configuration
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/html' }], ['json', { outputFile: 'test-results/results.json' }]],

  // Shared settings for all projects
  use: {
    // Collect trace on first retry
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Use the component testing viewport
    viewport: { width: 1280, height: 720 },

    // Component testing configuration
    ctPort: 3100,
    ctViteConfig: {
      resolve: {
        alias: {
          '@': resolve(__dirname, './src'),
        },
      },
    },
  },

  // Test projects for different browsers
  // Locally: Chromium only (fast). CI: all 3 browsers for cross-browser coverage.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    ...(process.env.CI
      ? [
          {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
          },
          {
            name: 'webkit',
            use: { ...devices['Desktop Safari'] },
          },
        ]
      : []),
  ],

  // Output directory for test artifacts
  outputDir: 'test-results/artifacts',
});
