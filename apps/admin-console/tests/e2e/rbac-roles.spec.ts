/**
 * Frame 21 — RBAC Roles screen spec: authenticated smoke of the list shell
 * (h1 + filter + roles table) and the rule 11 §11 axe gate in both themes.
 * Requires a running stack (skips otherwise, see helpers/stack.ts).
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

test.describe('RBAC roles screen', () => {
    test('renders the roles heading, filter bar and list region', async ({ page }) => {
        await page.goto('/rbac/roles');
        await expect(page.getByRole('heading', { level: 1, name: 'Roles' })).toBeVisible();
        await expect(page.getByLabel('Search roles')).toBeVisible();
        await expect(page.getByRole('button', { name: 'New role' }).first()).toBeVisible();
        await expect(page.getByRole('table', { name: 'Roles' })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/rbac/roles');
        await expect(page.getByRole('heading', { level: 1, name: 'Roles' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'Roles' })).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/rbac/roles');
        await expect(page.getByRole('heading', { level: 1, name: 'Roles' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'Roles' })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
