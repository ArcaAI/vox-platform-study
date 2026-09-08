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

import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// TASK-932: specs that need a microphone run in the `chromium-audio` project, where
// Chromium's fake capture device replays this clinical WAV (16 kHz mono PCM). The
// default `chromium` project ignores them so a plain run never asks for a mic.
const AUDIO_SPECS = /task-932-(consultation-scribe|consultation-audio|live-transcription)\.spec\.ts$/;
const FAKE_MIC_WAV = path.resolve(__dirname, 'tests/e2e/fixtures/audio/cardiology_consult_01.wav');

// Mirror the root playwright.config.ts convention: `.env.test` sets CI=false,
// so the flag must be parsed, never truthiness-coerced.
const isCI = ['1', 'true'].includes((process.env.CI ?? '').toLowerCase());

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // Locally the suite runs against `next dev` — ONE process compiling routes on
  // first visit and serving every worker. Parallelism starves it: measured on a
  // 16-core box, the same full suite gave 33 timeouts at Playwright's default
  // (~8 workers), 4 at 2 workers and 6 at 3, while every one of those specs
  // passed at 1. Raising the per-test budget to 45s did NOT help, which is the
  // tell — the constraint is server contention, not test duration.
  //
  // So the honest default is 1, matching CI. Set PLAYWRIGHT_WORKERS to trade
  // reliability for wall-clock when you know the specs you are running are light.
  workers: isCI ? 1 : Number(process.env.PLAYWRIGHT_WORKERS ?? 1),
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
      testIgnore: AUDIO_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'test-results/.auth/admin.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'chromium-audio',
      testMatch: AUDIO_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'test-results/.auth/admin.json',
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
          ],
        },
      },
      dependencies: ['setup'],
    },
  ],
  outputDir: 'test-results/artifacts',
  preserveOutput: 'failures-only',
});
