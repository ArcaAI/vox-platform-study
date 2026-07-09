/**
 * Frames 12 / 12.1 — tenants list + detail against a RUNNING stack (rule 12
 * gate 3): screen smoke plus axe scans in both themes. Skips with actionable
 * messages when the app or gateway is down.
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

/** Data rows are focusable (row click); skeleton rows are not. */
function dataRows(page: import('@playwright/test').Page) {
    return page.getByRole('grid', { name: 'Tenants' }).locator('[data-slot="data-grid-row"]');
}

async function waitForListSettled(page: import('@playwright/test').Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Tenants' })).toBeVisible();
    const emptyState = page.getByText('No tenants yet').or(page.getByText('No tenants match your filters'));
    await expect(dataRows(page).first().or(emptyState.first())).toBeVisible();
}

test.describe('tenants list (frame 12)', () => {
    test('shows the header with the table or an empty state', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        await expect(page.getByRole('button', { name: 'New tenant' }).first()).toBeVisible();
        await expect(page.getByLabel('Search')).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/tenants');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/tenants');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });
});

test.describe('tenant detail (frame 12.1)', () => {
    test('opens the first tenant and renders the header, tabs and overview', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        test.skip((await dataRows(page).count()) === 0, 'no tenants seeded — the list is empty');

        await dataRows(page).first().click();
        await page.waitForURL('**/tenants/**');

        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('tablist')).toBeVisible();
        for (const name of ['Overview', 'Usage', 'Configs', 'Tags', 'Frontend config']) {
            await expect(page.getByRole('tab', { name })).toBeVisible();
        }
        await expect(page.getByText('Tenant ID')).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('switching to the usage tab syncs the URL and loads the stats', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        test.skip((await dataRows(page).count()) === 0, 'no tenants seeded — the list is empty');

        await dataRows(page).first().click();
        await page.waitForURL('**/tenants/**');
        await page.getByRole('tab', { name: 'Usage' }).click();
        await expect(page).toHaveURL(/tab=usage/);
        await expect(page.getByText('Storage used')).toBeVisible();
    });
});
