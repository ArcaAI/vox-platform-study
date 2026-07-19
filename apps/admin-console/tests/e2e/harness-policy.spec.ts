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
    const resolveCard = page.getByText('Effective policy resolve').first();
    const errorState = page.getByRole('alert').first();
    try {
        await expect(resolveCard).toBeVisible();
    } catch {
        await expect(errorState).toBeVisible();
    }
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

test.describe('harness policy & live config \u2014 tenant policy editor (frame 36)', () => {
    test('opens the tenant policy editor for inherited or overridden policy', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        const emptyStateButton = page.getByRole('button', { name: 'Customize for tenant' });
        if (await emptyStateButton.isVisible().catch(() => false)) {
            await emptyStateButton.click();
        }
        await expect(page.getByRole('heading', { name: 'Tenant policy editor' })).toBeVisible();
        await expect(page.getByRole('form', { name: 'Policy save panel' })).toBeVisible();
    });

    test('editing and reverting a low-risk text field round-trips with no net mutation', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        const emptyStateButton = page.getByRole('button', { name: 'Customize for tenant' });
        if (await emptyStateButton.isVisible().catch(() => false)) {
            const hasExistingOverride = await page.evaluate(async () => {
                const list = await fetch('/api/hope/admin/tenants?page=0&limit=50');
                if (!list.ok) return false;
                const body = (await list.json()) as { data?: Array<{ id: string; name?: string }> };
                for (const candidate of body.data ?? []) {
                    await fetch('/api/auth/working-tenant', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ tenantId: candidate.id, tenantName: candidate.name }),
                    });
                    const policy = await fetch('/api/hope/admin/harness/policy');
                    if (policy.ok && ((await policy.json()) as { source?: string }).source === 'tenant') return true;
                }
                return false;
            });
            if (!hasExistingOverride) throw new Error('No seeded tenant policy override available for round-trip test');
            await page.goto('/harness/policy');
            await waitForSettled(page);
        }

        const form = page.getByRole('form', { name: 'Policy save panel' });
        await expect(form).toBeVisible();
        const fieldInput = form.getByLabel('Safety provider');
        const originalValue = await fieldInput.inputValue();
        const revertedValue = `${originalValue}-e2e-tmp`;
        const saveButton = form.getByRole('button', { name: 'Save \u00b7 If-Match' });

        try {
            await fieldInput.fill(revertedValue);
            await expect(form.getByText('Unsaved changes')).toBeVisible();
            await saveButton.click();
            await expect(page.getByText('Tenant harness policy saved')).toBeVisible();
            await expect(form.getByText('Unsaved changes')).toHaveCount(0);
            await expect(fieldInput).toHaveValue(revertedValue);
        } finally {
            await fieldInput.fill(originalValue);
            await expect(form.getByText('Unsaved changes')).toBeVisible();
            await saveButton.click();
            await expect(page.getByText('Tenant harness policy saved')).toBeVisible();
            await expect(fieldInput).toHaveValue(originalValue);
        }
    });

    test('the change-note reason input enforces maxlength 500', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        const emptyStateButton = page.getByRole('button', { name: 'Customize for tenant' });
        if (await emptyStateButton.isVisible().catch(() => false)) {
            await emptyStateButton.click();
        }
        const form = page.getByRole('form', { name: 'Policy save panel' });
        const reasonInput = form.getByLabel('Reason');
        await expect(reasonInput).toHaveAttribute('maxlength', '500');
    });

    test('the dirty-state indicator appears on edit and clears after reset', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        const emptyStateButton = page.getByRole('button', { name: 'Customize for tenant' });
        if (await emptyStateButton.isVisible().catch(() => false)) {
            await emptyStateButton.click();
        }
        const form = page.getByRole('form', { name: 'Policy save panel' });
        const fieldInput = form.getByLabel('Safety model');
        const originalValue = await fieldInput.inputValue();
        await expect(form.getByText('Unsaved changes')).toHaveCount(0);

        await fieldInput.fill(`${originalValue}-tmp`);
        await expect(form.getByText('Unsaved changes')).toBeVisible();

        await fieldInput.fill(originalValue);
        await expect(form.getByText('Unsaved changes')).toHaveCount(0);
    });
});

test.describe('harness policy & live config \u2014 live config tab (frame 36)', () => {
    test('the kill-switch and audit reason controls are present and interactive', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        await page.getByRole('tab', { name: 'Live config' }).click();
        await expect(page).toHaveURL(/tab=live/);

        const switchControl = page.getByRole('switch');
        const reasonInput = page.getByLabel('Audit reason');
        await expect(switchControl).toBeVisible();
        await expect(switchControl).toBeEnabled();
        await expect(reasonInput).toBeVisible();
        await expect(reasonInput).toBeEnabled();
        await expect(reasonInput).toHaveAttribute('maxlength', '500');
    });

    test('toggling the kill-switch and immediately reverting leaves no net mutation', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        await page.getByRole('tab', { name: 'Live config' }).click();
        await expect(page).toHaveURL(/tab=live/);

        const switchControl = page.getByRole('switch');
        const reasonInput = page.getByLabel('Audit reason');
        const saveButton = page.getByRole('button', { name: 'Save live config' });
        const originalChecked = await switchControl.isChecked();

        try {
        await switchControl.click();
        await expect(switchControl).toHaveAttribute('aria-checked', String(!originalChecked));
        await expect(page.getByText('Unsaved changes')).toBeVisible();
        await reasonInput.fill('e2e: temporary toggle for coverage, reverting immediately');
        await saveButton.click();
        await expect(page.getByText(originalChecked ? 'Kill-switch engaged' : 'Live documentation engine enabled')).toBeVisible();
        await page.goto('/harness/policy');
        await waitForSettled(page);
        await page.getByRole('tab', { name: 'Live config' }).click();
        await expect(page).toHaveURL(/tab=live/);
        await expect(switchControl).toHaveAttribute('aria-checked', String(!originalChecked));

        await switchControl.click();
        await expect(page.getByText('Unsaved changes')).toBeVisible();
        await reasonInput.fill('e2e: reverting kill-switch back to original state');
        await saveButton.click();
        await expect(page.getByText(originalChecked ? 'Live documentation engine enabled' : 'Kill-switch engaged')).toBeVisible();
        } finally {
            await page.evaluate(async (enabled) => {
                const response = await fetch('/api/hope/admin/harness/live/config', {
                    method: 'PATCH',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ enabled, reason: 'e2e cleanup: restore original live config' }),
                });
                if (!response.ok) throw new Error(`Failed to restore live config (${response.status})`);
            }, originalChecked);
        }

        const finalConfig = await page.evaluate(async () => {
            const res = await fetch('/api/hope/admin/harness/live/config');
            return res.ok ? ((await res.json()) as { enabled: boolean }).enabled : null;
        });
        expect(finalConfig).toBe(originalChecked);
    });
});

test.describe('harness policy & live config \u2014 global default tab (frame 36)', () => {
    test('renders the same form structure as the tenant editor, read-only assertions only', async ({ page }) => {
        await page.goto('/harness/policy');
        await waitForSettled(page);
        await page.getByRole('tab', { name: 'Global default' }).click();
        await expect(page).toHaveURL(/tab=global/);
        await expect(page.getByRole('heading', { name: 'Global default editor' })).toBeVisible();
        const form = page.getByRole('form', { name: 'Policy save panel' });
        await expect(form).toBeVisible();
        await expect(form.getByLabel('Safety guardrail')).toBeVisible();
        await expect(form.getByLabel('Reason')).toBeVisible();
        await expect(form.getByRole('button', { name: 'Save \u00b7 If-Match' })).toBeDisabled();
    });
});
