/**
 * Frame 36 — Harness Policy & Live Config against a RUNNING stack (rule 12
 * gate 3): screen smoke, tab interaction plus axe scans in both themes.
 * Skips with actionable messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Harness policy is tenant-scoped: elevated sessions see the
    // "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Harness Policy & Live Config' })).toBeVisible();
    // The tenant tab settles into the resolve card (with or without a tenant
    // override row) or the block error state.
    const resolveCard = page.getByText('Effective policy resolve');
    const errorState = page.getByRole('alert');
    await expect(resolveCard.first().or(errorState.first())).toBeVisible();
}

test.describe('harness policy & live config (frame 36)', () => {
    test('shows the header, tabs, resolve card and the comparison grid', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        // The seeded admin is elevated, so all three tabs render.
        for (const name of ['Tenant policy', 'Live config', 'Global default']) {
            await expect(page.getByRole('tab', { name })).toBeVisible();
        }
        await expect(page.getByRole('table', { name: 'Tenant vs global default settings' })).toBeVisible();
    });

    test('the live-config tab syncs the URL and renders the kill-switch region', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        await page.getByRole('tab', { name: 'Live config' }).click();
        await expect(page).toHaveURL(/tab=live/);
        await expect(page.getByText('Live documentation engine')).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/harness/policy');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/harness/policy');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
