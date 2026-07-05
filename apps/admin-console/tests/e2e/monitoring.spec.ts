/**
 * Frame 11 — Monitoring screen spec: loaded regions + the rule 11 §11 axe
 * gate in both themes. Skips when the stack is not running.
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

async function assertLoadedMonitoring(page: Page): Promise<void> {
    await expect(page.getByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
    // One meaningful region per data source: probe grid + Redis health card.
    await expect(page.getByRole('heading', { level: 2, name: 'Service health' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Redis health' })).toBeVisible();
    await expect(page.getByText('Services healthy').first()).toBeVisible();
}

test.describe('monitoring', () => {
    test('renders loaded regions with no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/monitoring');
        await assertLoadedMonitoring(page);
        await expectNoA11yViolations(page);
    });

    test('renders loaded regions with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/monitoring');
        await assertLoadedMonitoring(page);
        await expectNoA11yViolations(page);
    });
});
