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
        page.getByRole('grid', { name: 'Plan entitlements' }).locator('[data-slot="data-grid-row"]').first().or(emptyState.first()),
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

    test('cancelling the disable-enforcement confirm leaves the switch unchanged', async ({ page }) => {
        await page.goto('/entitlements');
        await waitForSettled(page);
        const enforcementSwitch = page.getByRole('switch');
        const before = await enforcementSwitch.getAttribute('aria-checked');
        if (before !== 'true') {
            await page.evaluate(() =>
                fetch('/api/hope/admin/entitlements/enabled', {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ enabled: true }),
                }),
            );
            await page.reload();
            await waitForSettled(page);
        }
        try {
            await expect(enforcementSwitch).toHaveAttribute('aria-checked', 'true');
            await enforcementSwitch.click();
            const dialog = page.getByRole('alertdialog', { name: 'Disable enforcement?' });
            await expect(dialog).toBeVisible();
            await expect(dialog.getByText('Every tenant immediately bypasses plan limits and feature gates')).toBeVisible();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await expect(dialog).toBeHidden();
            await expect(enforcementSwitch).toHaveAttribute('aria-checked', 'true');
        } finally {
            if (before !== 'true') {
                await page.evaluate(() =>
                    fetch('/api/hope/admin/entitlements/enabled', {
                        method: 'PUT',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ enabled: false }),
                    }),
                );
            }
        }
    });

    test('running trial expiry confirms and reports a completed sweep', async ({ page }) => {
        await page.goto('/entitlements');
        await waitForSettled(page);
        await page.getByRole('button', { name: 'Run trial expiry' }).click();
        const dialog = page.getByRole('alertdialog', { name: 'Run trial expiry?' });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Run trial expiry' }).click();
        await expect(page.getByText(/Trial expiry sweep done/)).toBeVisible();
        await expect(dialog).toBeHidden();
    });

    test('loading a real tenant on the overrides tab shows its effective entitlements', async ({ page }) => {
        await page.goto('/entitlements');
        await waitForSettled(page);
        await page.getByRole('tab', { name: 'Tenant overrides' }).click();
        const tenantId = await page.evaluate(async () => {
            const response = await fetch('/api/hope/admin/tenants?page=0&limit=100');
            if (!response.ok) return null;
            const body = (await response.json()) as { data?: Array<{ id: string }> };
            return body.data?.find((tenant) => !tenant.id.startsWith('00000000'))?.id ?? null;
        });
        expect(tenantId, 'No non-system tenants seeded; cannot load a tenant override').toBeTruthy();
        await page.getByLabel('Tenant ID').fill(tenantId as string);
        await page.getByRole('button', { name: 'Load tenant' }).click();
        await expect(page.getByRole('heading', { level: 2, name: 'Effective entitlements' })).toBeVisible();
        await expect(page.getByRole('heading', { level: 2, name: 'Tenant override' })).toBeVisible();
    });

    test('the plans grid search filters the visible rows', async ({ page }) => {
        await page.goto('/entitlements');
        await waitForSettled(page);
        const grid = page.getByRole('grid', { name: 'Plan entitlements' });
        const rowsBefore = grid.locator('[data-slot="data-grid-row"]');
        const countBefore = await rowsBefore.count();
        expect(countBefore).toBeGreaterThan(0);
        await page.getByRole('textbox', { name: 'Search' }).fill('does-not-exist-plan-xyz');
        await expect(page.getByText('No plans match your search')).toBeVisible();
        await page.getByRole('textbox', { name: 'Search' }).fill('');
        await expect(grid.locator('[data-slot="data-grid-row"]')).toHaveCount(countBefore);
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
