import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Playwright config for ui-playground E2E tests.
 *
 * Prerequisites (must be running externally):
 *   - API Gateway (NestJS):   http://localhost:8868
 *   - stt-v2 (FastAPI):       http://localhost:8861
 *   - Redis:                  localhost:6379
 *   - PostgreSQL:             localhost:5432
 *   - ui-playground (Vite):   http://localhost:5175
 *
 * Environment variables:
 *   PLAYGROUND_URL         - Base URL (default: http://localhost:5175)
 *   PLAYGROUND_API_KEY     - API key for authentication
 *   PLAYGROUND_TENANT_ID   - Tenant ID for authentication
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHARED_CHROME_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

function chromeProjectWithAudio(name: string, specFile: string, audioFixture: string) {
  return {
    name,
    testMatch: specFile,
    use: {
      ...devices['Desktop Chrome'],
      channel: 'chrome' as const,
      permissions: ['microphone'] as string[],
      launchOptions: {
        args: [
          ...SHARED_CHROME_ARGS,
          `--use-file-for-fake-audio-capture=${path.resolve(__dirname, audioFixture)}`,
        ],
      },
    },
  };
}

export default defineConfig({
  testDir: './',
  testMatch: '**/*.e2e.spec.ts',

  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },

  reporter: [['list'], ['html', { open: 'never', outputFolder: './test-results/html' }], ...(process.env.CI ? [['github'] as const] : [])],

  outputDir: './test-results/artifacts',

  use: {
    baseURL: process.env.PLAYGROUND_URL || 'http://127.0.0.1:5175',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'on',
  },
  projects: [
    chromeProjectWithAudio('asr-en', 'asr-en.e2e.spec.ts', 'fixtures/asr_en.wav'),
    chromeProjectWithAudio('asr-ml', 'asr-ml.e2e.spec.ts', 'fixtures/asr_ml.wav'),
    chromeProjectWithAudio('code-switching-en-vi', 'code-switching-en-vi.e2e.spec.ts', 'fixtures/code-switching-en-vi.wav'),
  ],
});
