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

// CI must be parsed, not coerced. `.env.test` sets `CI=false`, and a bare
// `process.env.CI` truthy check treats the non-empty string "false" as CI —
// which wrongly enabled retries/single-worker/forbidOnly on local runs (the
// source of the "Retry #1/#2" noise in local failures). Mirror the
// global-setup convention (real CI sets CI=true|1) so local and CI agree.
const isCI = ['1', 'true'].includes((process.env.CI ?? '').toLowerCase());

const baseURL = process.env.API_URL || 'http://localhost:8968/api/v1';

/**
 * Specs whose tests drive real model inference. Kept as an explicit list rather
 * than a glob so adding one is a deliberate act — a spec lands here only when it
 * genuinely waits on a model, never to paper over a slow gateway path.
 */
const INFERENCE_SPECS = [
  '**/ai-inference-proxy.spec.ts',
  '**/byo-llm-credentials.spec.ts',
  '**/consultation-job-cross-tenant.spec.ts',
  '**/task-562-text-compat.spec.ts',
  '**/task-704-generator-seam.spec.ts',
  '**/task-708-apikey-scope-contract.spec.ts',
  '**/task-760-uri-normalization.spec.ts',
  '**/task-767-standalone-feature-credentials.spec.ts',
  '**/task-779-core-business.spec.ts',
];

/** Test-level budget for the inference project (see the project comment). */
const INFERENCE_TEST_TIMEOUT_MS = 240_000;

/**
 * Specs that need the shared ASR worker TO THEMSELVES.
 *
 * `streaming-backpressure-recovery` floods 24s of audio and then asserts that
 * captions RESUME — which requires the STT worker to actually transcribe that
 * backlog. Run alongside the other streaming specs (and task-767's sessions) it
 * competes for the single local model and reports `transcriptsReceived: 0`
 * however long it waits: measured green in isolation (1 caption, ~20s) and red
 * inside the full suite even with a 120s window and a clean Redis. The
 * contended resource is finite and real, so the fix is exclusivity, not a
 * bigger number.
 */
const EXCLUSIVE_SPECS = ['**/streaming-backpressure-recovery.spec.ts'];

export default defineConfig({
  // Test directory
  testDir: './apps/api/tests/e2e',

  // Test file pattern
  testMatch: '**/*.spec.ts',

  // Run tests in parallel
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: isCI,

  // Retry failed tests in CI
  retries: isCI ? 2 : 0,

  // Number of workers
  workers: isCI ? 1 : undefined,

  // Reporter configuration
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ...(isCI ? [['github'] as const] : []),
  ],

  // Global timeout for each test. Deliberately tight: an API assertion that
  // needs longer than this is either broken or waiting on real inference, and
  // the latter is carved out by the `api-inference-tests` project below.
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
      testIgnore: [...INFERENCE_SPECS, ...EXCLUSIVE_SPECS],
    },
    {
      // Specs that drive REAL model inference (STT/LLM/guardrail) rather than a
      // gateway-only path. Their assertions are already latency-agnostic — they
      // accept `200 | 500 | 502 | 503` so a down provider still passes — but a
      // 30s cap turns "the local provider is busy" into a red test: measured
      // generations on this stack run 4-21s each against a single model
      // instance, so concurrent callers queue. Splitting them out keeps the
      // tight default honest for the other ~1150 tests.
      //
      // NOTE: the per-test timeout is only half the budget. `APIRequestContext`
      // applies its OWN 30s default per request, so an inference call site must
      // ALSO pass `timeout:` explicitly — raising this alone is not enough.
      name: 'api-inference-tests',
      testMatch: INFERENCE_SPECS,
      timeout: INFERENCE_TEST_TIMEOUT_MS,
    },
    {
      // Runs LAST and ALONE: `dependencies` makes Playwright finish both
      // projects above before starting this one, so the ASR worker is idle when
      // the flood lands.
      //
      // TRADE-OFF, deliberate: Playwright SKIPS a project whose dependency had
      // failures, so an unrelated red test elsewhere reports this one as "did
      // not run" rather than executing it. That is acceptable — the run is
      // already red in that case — and it is the price of not letting this
      // test's result depend on what else happens to be transcribing.
      name: 'api-exclusive-tests',
      testMatch: EXCLUSIVE_SPECS,
      timeout: INFERENCE_TEST_TIMEOUT_MS,
      dependencies: ['api-tests', 'api-inference-tests'],
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
