/**
 * Frame 25 (account half) — Account screen spec: authenticated smoke of the
 * session identity region and the rule 11 §11 axe gate in both themes.
 * Requires a running stack (skips otherwise).
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { ADMIN_CREDENTIALS, API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

test.describe('account screen', () => {
    test('renders the identity region from the BFF session', async ({ page }) => {
        await page.goto('/account');
        await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
        const identity = page.getByRole('region', { name: 'Identity' });
        await expect(identity).toBeVisible();
        await expect(identity).toContainText(ADMIN_CREDENTIALS.username);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/account');
        await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Identity' })).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/account');
        await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Identity' })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
