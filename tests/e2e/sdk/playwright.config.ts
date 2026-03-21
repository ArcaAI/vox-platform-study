/**
 * Playwright Configuration for SDK E2E Tests
 *
 * Separate configuration for SDK-specific E2E tests.
 */

import { defineConfig } from '@playwright/test';

const baseURL = process.env.API_URL || 'http://localhost:8868';

export default defineConfig({
    testDir: './',
    testMatch: '**/*.e2e.spec.ts',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,

    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: '../../../test-results/sdk-e2e/html' }],
        ['json', { outputFile: '../../../test-results/sdk-e2e/results.json' }],
    ],

    timeout: 30000,

    expect: {
        timeout: 10000,
    },

    use: {
        baseURL,
        extraHTTPHeaders: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        trace: 'on-first-retry',
    },

    projects: [
        {
            name: 'sdk-api-tests',
            testMatch: '**/*.e2e.spec.ts',
        },
    ],

    outputDir: '../../../test-results/sdk-e2e/artifacts',
});
