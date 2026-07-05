/**
 * Frame 18 — Audit logs screen spec: shell + read-only event list render
 * against the live stack, axe gate in both themes (rule 11 §11), and the
 * JSON detail drawer over the first row when the environment has events.
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

async function openAuditLogs(page: Page) {
    await page.goto('/audit-logs');
    await expect(page.getByRole('heading', { level: 1, name: 'Audit logs' })).toBeVisible();
    await expect(page.getByLabel('Filter by actor user id')).toBeVisible();
    // Settle the list (skeletons mirror the layout, then give way to data).
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Audit events' })).toBeVisible();
}

test.describe('audit logs screen', () => {
    test('renders the event list with no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openAuditLogs(page);
        await expectNoA11yViolations(page);
    });

    test('renders the event list with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await openAuditLogs(page);
        await expectNoA11yViolations(page);
    });

    test('opens the read-only JSON detail drawer from the first row', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await openAuditLogs(page);
        const rows = page.getByRole('table', { name: 'Audit events' }).locator('tbody tr');
        const rowCount = await rows.count();
        test.skip(rowCount === 0, 'no audit events recorded in this environment');
        await rows.first().click();
        const drawer = page.getByRole('dialog');
        await expect(drawer).toBeVisible();
        await expect(drawer.getByText('Full audit record — read-only.')).toBeVisible();
        await expect(drawer.getByRole('button', { name: 'Copy audit log id' })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
