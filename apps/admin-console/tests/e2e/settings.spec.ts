/**
 * Frame 24 — Settings & secrets screen spec: authenticated smoke of the list
 * regions (h1, new-setting action, scope tabs, table or empty state) and the
 * rule 11 §11 axe gate in both themes. Requires a running stack.
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

async function waitForListSettled(page: import('@playwright/test').Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Settings & secrets' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Global settings' });
    const emptyState = page.getByText('No settings yet').or(page.getByText('No settings match your search'));
    await expect(table.locator('tbody tr').first().or(emptyState.first())).toBeVisible();
}

test.describe('settings & secrets screen (frame 24)', () => {
    test('shows the header with the global tab and the table or an empty state', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        await expect(page.getByRole('button', { name: 'New setting' }).first()).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Global' })).toBeVisible();
        await expect(page.getByLabel('Search settings')).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/settings');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/settings');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });
});
