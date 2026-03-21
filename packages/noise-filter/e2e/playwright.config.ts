/**
 * Playwright Configuration for @arcaai/noise-filter E2E Tests
 *
 * Browser-based E2E tests for the noise filter plugin package.
 * Tests real browser APIs: WebAssembly, AudioContext, AudioWorklet, etc.
 */

import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  testDir: './',
  testMatch: '**/*.e2e.spec.ts',

  // Run tests sequentially for audio tests (can conflict with each other)
  fullyParallel: false,

  // Fail build on CI if test.only is left in
  forbidOnly: !!process.env.CI,

  // Retry failed tests
  retries: process.env.CI ? 2 : 1,

  // Single worker for audio tests
  workers: 1,

  // Reporter configuration
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './test-results/html' }],
    ['json', { outputFile: './test-results/results.json' }],
  ],

  // Longer timeout for WASM loading and audio processing
  timeout: 90000,

  expect: {
    timeout: 20000,
  },

  // Shared settings for all projects
  use: {
    // Collect trace on first retry
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on failure
    video: 'on-first-retry',

    // Browser permissions for audio
    permissions: ['microphone'],

    // Launch options
    launchOptions: {
      // Required for audio processing in headless mode
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },

  // Test projects for different browsers
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            // Enable SharedArrayBuffer (requires cross-origin isolation)
            '--enable-features=SharedArrayBuffer',
          ],
        },
      },
    },
    // Firefox - test ScriptProcessor fallback
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.permission.disabled': true,
            'media.navigator.streams.fake': true,
          },
        },
      },
    },
    // WebKit (Safari) - test Safari-specific behavior
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
      },
    },
  ],

  // Web server to serve test fixtures
  webServer: {
    command: 'npx http-server ./e2e/fixtures -p 3334 -c-1 --cors',
    port: 3334,
    timeout: 30000,
    reuseExistingServer: !process.env.CI,
    cwd: path.resolve(__dirname, '..'),
  },

  // Output directory for test artifacts
  outputDir: './test-results/artifacts',
});
