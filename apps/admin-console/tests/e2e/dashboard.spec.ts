/**
 * Frame 10 — Platform Dashboard screen spec: loaded regions + the rule 11 §11
 * axe gate in both themes. Skips when the stack is not running.
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

async function assertLoadedDashboard(page: Page): Promise<void> {
    await expect(page.getByRole('heading', { level: 1, name: 'Platform Dashboard' })).toBeVisible();
    // One meaningful region per audience: stat tiles + the audit activity card.
    await expect(page.getByText('Requests / min').first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Recent admin activity' })).toBeVisible();
    // Scope to main: the sidebar carries an identically named nav link.
    await expect(page.getByRole('main').getByRole('link', { name: /audit logs/i })).toBeVisible();
}

test.describe('platform dashboard', () => {
    test('renders loaded regions with no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/dashboard');
        await assertLoadedDashboard(page);
        await expectNoA11yViolations(page);
    });

    test('renders loaded regions with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/dashboard');
        await assertLoadedDashboard(page);
        await expectNoA11yViolations(page);
    });
});
