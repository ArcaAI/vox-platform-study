/**
 * Frame 37 — Harness observability against a RUNNING stack (rule 12 gate 3):
 * screen smoke plus axe scans in both themes. Skips with actionable messages
 * when the app or gateway is down. The harness admin endpoints proxy to a
 * Temporal-backed service that may be down in local dev, so "settled" accepts
 * data, empty or the error posture (the chain badge resolves in all three).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Harness observability is tenant-scoped: elevated sessions see the
    // "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Harness Observability' })).toBeVisible();
    // The chain verdict badge leaves its loading skeleton in every terminal
    // state: intact/broken with data, unverified when the audit read failed.
    const verdict = page.getByText('Chain intact').or(page.getByText('Chain broken')).or(page.getByText('Unverified'));
    await expect(verdict.first()).toBeVisible();
}

test.describe('harness observability (frame 37)', () => {
    test('shows the header, filter strip and the three panels', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
        await expect(page.getByLabel('Search audit rows')).toBeVisible();
        for (const name of ['Chain integrity', 'Eval runs', 'Gate queue']) {
            await expect(page.getByRole('heading', { level: 2, name: new RegExp(name) })).toBeVisible();
        }
    });

    test('the audit search syncs to the URL', async ({ page }) => {
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await page.getByLabel('Search audit rows').fill('gate');
        await expect(page).toHaveURL(/search=gate/);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/harness/observability');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
