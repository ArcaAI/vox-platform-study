/**
 * Frame 30 — Departments against a RUNNING stack (rule 12 gate 3): screen
 * smoke plus axe scans in both themes. Skips with actionable messages when
 * the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Departments are tenant-scoped: elevated sessions see the "Select a
    // working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Departments' })).toBeVisible();
    const emptyState = page.getByText('No departments yet');
    // The hierarchy list renders once the roots landed; empty tenants show
    // the neutral empty state instead.
    const treeNodes = page.getByRole('list', { name: 'Department hierarchy' }).locator('li');
    await expect(treeNodes.first().or(emptyState.first())).toBeVisible();
}

test.describe('departments (frame 30)', () => {
    test('shows the header, filter strip and the hierarchy region', async ({ page }) => {
        await page.goto('/departments');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'New department' }).first()).toBeVisible();
        await expect(page.getByLabel('Search departments')).toBeVisible();
    });

    test('the department search syncs the URL', async ({ page }) => {
        await page.goto('/departments');
        await waitForSettled(page);
        await page.getByLabel('Search departments').fill('card');
        // 300ms debounce before the nuqs write lands in the URL.
        await expect(page).toHaveURL(/q=card/);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/departments');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/departments');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
