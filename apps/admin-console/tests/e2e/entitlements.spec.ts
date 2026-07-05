/**
 * Frame 13 — Entitlements & plans against a RUNNING stack (rule 12 gate 3):
 * screen smoke plus axe scans in both themes. Skips with actionable messages
 * when the app or gateway is down.
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

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Entitlements & Plans' })).toBeVisible();
    // Enforcement card settles from skeleton to the switch once the read lands.
    await expect(page.getByRole('switch')).toBeVisible();
    const emptyState = page.getByText('No plan entitlements yet');
    await expect(
        page.getByRole('table', { name: 'Plan entitlements' }).locator('tbody tr').first().or(emptyState.first()),
    ).toBeVisible();
}

test.describe('entitlements & plans (frame 13)', () => {
    test('shows the header, enforcement toggle, tabs and the plans region', async ({ page }) => {
        await page.goto('/entitlements');
        await waitForSettled(page);
        await expect(page.getByRole('tab', { name: 'Plans' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Tenant overrides' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Run trial expiry' })).toBeVisible();
    });

    test('the overrides tab syncs the URL and offers the tenant loader', async ({ page }) => {
        await page.goto('/entitlements');
        await waitForSettled(page);
        await page.getByRole('tab', { name: 'Tenant overrides' }).click();
        await expect(page).toHaveURL(/tab=overrides/);
        await expect(page.getByLabel('Tenant ID')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Load tenant' })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/entitlements');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/entitlements');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
