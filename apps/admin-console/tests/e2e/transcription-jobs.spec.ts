/**
 * Frame 35 — Transcription jobs against a RUNNING stack (rule 12 gate 3):
 * screen smoke plus axe scans in both themes. Skips with actionable messages
 * when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // The jobs surface is tenant-scoped: elevated sessions see the "Select a
    // working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Transcription Jobs' })).toBeVisible();
    const emptyState = page.getByText('No transcription jobs yet');
    // Data rows are focusable (row click -> stream panel); skeletons are not.
    const dataRows = page.getByRole('table', { name: 'Transcription jobs' }).locator('tbody tr[tabindex="0"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
}

test.describe('transcription jobs (frame 35)', () => {
    test('shows the header, stats strip, filters and the stream panel shell', async ({ page }) => {
        await page.goto('/audio/transcription-jobs');
        await waitForSettled(page);
        const stats = page.getByRole('region', { name: 'Job status counts' });
        for (const label of ['Queued', 'Running', 'Completed', 'Failed']) {
            await expect(stats.getByText(label)).toBeVisible();
        }
        await expect(page.getByLabel('Search job id')).toBeVisible();
        await expect(page.getByText('Job stream')).toBeVisible();
        await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();
    });

    test('the failed stat card applies the FAILED status filter to the URL', async ({ page }) => {
        await page.goto('/audio/transcription-jobs');
        await waitForSettled(page);
        await page.getByRole('button', { name: /filter the grid to failed jobs/i }).click();
        await expect(page).toHaveURL(/status=FAILED/);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/audio/transcription-jobs');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/audio/transcription-jobs');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
