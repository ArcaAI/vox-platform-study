/**
 * Playwright Configuration
 *
 * Configuration for E2E API testing with Playwright.
 * See: https://playwright.dev/docs/test-configuration
 *
 * NOTE: Environment variables are loaded via dotenv-cli in package.json:
 *   "test:e2e": "dotenv -e .env.test -- playwright test"
 *
 * This ensures .env.test is used and not overridden by other .env files.
 */

import { defineConfig } from '@playwright/test';

// Verify test environment (should be set by dotenv-cli)
if (process.env.NODE_ENV !== 'test') {
  console.warn('WARNING: NODE_ENV is not "test". Run with: pnpm test:e2e');
}

const baseURL = process.env.API_URL || 'http://localhost:8868/api/v1';

export default defineConfig({
  // Test directory
  testDir: './apps/api/tests/e2e',

  // Test file pattern
  testMatch: '**/*.spec.ts',

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,

  // Retry failed tests in CI
  retries: process.env.CI ? 2 : 0,

  // Number of workers
  workers: process.env.CI ? 1 : undefined,

  // Reporter configuration
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ...(process.env.CI ? [['github'] as const] : []),
  ],

  // Global timeout for each test
  timeout: 30000,

  // Expect timeout
  expect: {
    timeout: 10000,
  },

  // Shared settings for all projects
  use: {
    // Base URL for API requests
    baseURL,

    // Default headers for all requests
    extraHTTPHeaders: {
      Accept: 'application/json',
    },

    // Collect trace on first retry
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',
  },

  // Test projects
  projects: [
    {
      name: 'api-tests',
      testMatch: '**/*.spec.ts',
    },
  ],

  // Global setup and teardown
  globalSetup: './tests/setup/playwright.global-setup.ts',
  globalTeardown: './tests/setup/playwright.global-teardown.ts',

  // Output directory for test artifacts
  outputDir: 'test-results/artifacts',

  // Preserve output on failure
  preserveOutput: 'failures-only',
});
