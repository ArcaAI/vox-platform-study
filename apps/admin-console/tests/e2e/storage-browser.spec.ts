/**
 * Frame 31 — tenant Storage browser against a RUNNING stack (rule 12 gate 3):
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
    // The storage browser is tenant-scoped: elevated sessions see the
    // "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Storage' })).toBeVisible();
    // Data rows are focusable (row click -> select/descend); a tenant with no
    // physical buckets settles on the bucket-card empty state instead.
    const dataRows = page.getByRole('table', { name: 'Bucket objects' }).locator('tbody tr[tabindex="0"]');
    const emptyObjects = page.getByText('No objects here');
    const emptyBuckets = page.getByText('No buckets', { exact: true });
    await expect(dataRows.first().or(emptyObjects.first()).or(emptyBuckets.first())).toBeVisible();
}

test.describe('storage browser (frame 31)', () => {
    test('shows the header, filter strip and the three panels', async ({ page }) => {
        await page.goto('/storage');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'Upload files' }).first()).toBeVisible();
        await expect(page.getByLabel('Search objects')).toBeVisible();
        await expect(page.getByText('Buckets', { exact: true })).toBeVisible();
        await expect(page.getByText('Object actions')).toBeVisible();
        await expect(page.getByText(/Health:/)).toBeVisible();
    });

    test('the object search syncs the URL and keeps the grid region', async ({ page }) => {
        await page.goto('/storage');
        await waitForSettled(page);
        await page.getByLabel('Search objects').fill('wav');
        await expect(page).toHaveURL(/search=wav/);
        await expect(page.getByRole('table', { name: 'Bucket objects' })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/storage');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/storage');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
