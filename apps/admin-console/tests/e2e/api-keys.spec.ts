/**
 * Frame 23 — API keys screen spec: authenticated smoke of the list regions
 * (h1, create action, filter bar, table or empty state) and the rule 11 §11
 * axe gate in both themes. Requires a running stack (skips otherwise).
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
    await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();
    const table = page.getByRole('grid', { name: 'API keys' });
    const emptyState = page.getByText('No API keys yet').or(page.getByText('No keys match your filters'));
    await expect(table.locator('[data-slot="data-grid-row"]').first().or(emptyState.first())).toBeVisible();
}

test.describe('api keys screen (frame 23)', () => {
    test('shows the header with the table or an empty state', async ({ page }) => {
        await page.goto('/api-keys');
        await waitForListSettled(page);
        await expect(page.getByRole('button', { name: 'Create key' }).first()).toBeVisible();
        await expect(page.getByLabel('Search')).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/api-keys');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/api-keys');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });
});
