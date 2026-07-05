/**
 * Frame 32 — Agents & Prompt Templates against a RUNNING stack (rule 12
 * gate 3): screen smoke plus axe scans in both themes. Skips with actionable
 * messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Prompt templates are tenant-scoped: elevated sessions see the
    // "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Agents & Prompt Templates' })).toBeVisible();
    const emptyState = page.getByText('No prompt templates yet');
    // Data rows are focusable (row click -> selection); skeleton rows are not.
    const dataRows = page.getByRole('table', { name: 'Prompt templates' }).locator('tbody tr[tabindex="0"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
}

test.describe('agents & prompt templates (frame 32)', () => {
    test('shows the header, filter strip and the templates region', async ({ page }) => {
        await page.goto('/agents');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'New template' }).first()).toBeVisible();
        await expect(page.getByLabel('Search templates')).toBeVisible();
        await expect(page.getByLabel('Status')).toBeVisible();
        await expect(page.getByLabel('Department')).toBeVisible();
    });

    test('the status filter syncs to the URL', async ({ page }) => {
        await page.goto('/agents');
        await waitForSettled(page);
        await page.getByLabel('Status').click();
        await page.getByRole('option', { name: 'Draft' }).click();
        await expect(page).toHaveURL(/status=DRAFT/);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/agents');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/agents');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
