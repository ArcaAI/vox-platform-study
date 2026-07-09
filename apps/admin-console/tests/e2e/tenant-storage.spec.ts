/**
 * Frame 14 — Tenant storage administration against a RUNNING stack (rule 12
 * gate 3): screen smoke plus axe scans in both themes. Skips with actionable
 * messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Storage administration is tenant-scoped: elevated sessions see the
    // "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Tenant Storage Administration' })).toBeVisible();
    const emptyState = page.getByText('No buckets provisioned yet');
    // Data rows are focusable (row click -> object browser); skeleton rows are not.
    const dataRows = page.getByRole('grid', { name: 'Tenant buckets' }).locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
}

test.describe('tenant storage (frame 14)', () => {
    test('shows the header, tabs and the buckets region', async ({ page }) => {
        await page.goto('/tenants/storage');
        await waitForSettled(page);
        for (const name of ['Buckets', 'Defaults', 'Configs', 'Access keys']) {
            await expect(page.getByRole('tab', { name })).toBeVisible();
        }
        await expect(page.getByRole('button', { name: 'Provision buckets' }).first()).toBeVisible();
        await expect(page.getByLabel('Search')).toBeVisible();
    });

    test('the access-keys tab syncs the URL and renders its region', async ({ page }) => {
        await page.goto('/tenants/storage');
        await waitForSettled(page);
        await page.getByRole('tab', { name: 'Access keys' }).click();
        await expect(page).toHaveURL(/tab=keys/);
        await expect(page.getByRole('button', { name: 'Create access key' }).first()).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/tenants/storage');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/tenants/storage');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
