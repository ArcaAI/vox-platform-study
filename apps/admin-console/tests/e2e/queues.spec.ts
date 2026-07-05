/**
 * Frame 17 — Queues & Jobs screen spec: shell + list render against the live
 * stack, axe gate in both themes (rule 11 §11), and a guarded drill-down into
 * the first queue's detail board.
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

async function openQueues(page: Page) {
    await page.goto('/queues');
    await expect(page.getByRole('heading', { level: 1, name: 'Queues & Jobs' })).toBeVisible();
    await expect(page.getByLabel('Search queues')).toBeVisible();
    // Settle the list (skeletons mirror the layout, then give way to data).
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
}

test.describe('queues screen', () => {
    test('renders the list with no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openQueues(page);
        await expectNoA11yViolations(page);
    });

    test('renders the list with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await openQueues(page);
        await expectNoA11yViolations(page);
    });

    test('drills into the first queue detail when a queue exists', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openQueues(page);
        const rows = page.getByRole('table', { name: 'Queues' }).locator('tbody tr');
        const rowCount = await rows.count();
        test.skip(rowCount === 0, 'no queues registered in this environment');
        const queueName = (await rows.first().locator('td').first().innerText()).trim();
        await rows.first().click();
        await page.waitForURL('**/queues/**');
        await expect(page.getByRole('heading', { level: 1, name: queueName })).toBeVisible();
        await expect(page.getByRole('table', { name: 'Jobs' })).toBeVisible();
        await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
        await expectNoA11yViolations(page);
    });
});
