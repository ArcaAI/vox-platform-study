/**
 * Frame 17.1 — Schedulers screen spec: shell + table render against the live
 * stack and the axe gate in both themes (rule 11 §11).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

async function openSchedulers(page: Page) {
    await page.goto('/schedulers');
    await expect(page.getByRole('heading', { level: 1, name: 'Schedulers' })).toBeVisible();
    await expect(page.getByLabel('Search schedules')).toBeVisible();
    // Settle the table (skeletons mirror the layout, then give way to data).
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
}

test.describe('schedulers screen', () => {
    test('renders the table with no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openSchedulers(page);
        await expectNoA11yViolations(page);
    });

    test('renders the table with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await openSchedulers(page);
        await expectNoA11yViolations(page);
    });
});
