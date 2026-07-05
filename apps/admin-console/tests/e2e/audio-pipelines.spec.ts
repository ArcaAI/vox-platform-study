/**
 * Frame 34 — Audio pipelines against a RUNNING stack (rule 12 gate 3): screen
 * smoke plus axe scans in both themes. Skips with actionable messages when the
 * app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Pipelines are tenant-scoped: elevated sessions see the "Select a
    // working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Audio Pipelines' })).toBeVisible();
    const emptyState = page.getByText('No pipelines for this tenant');
    // Data rows are focusable (row click -> selection); skeleton rows are not.
    const dataRows = page.getByRole('table', { name: 'Audio pipelines' }).locator('tbody tr[tabindex="0"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
}

test.describe('audio pipelines (frame 34)', () => {
    test('shows the header, filters and the three panels', async ({ page }) => {
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'New pipeline' }).first()).toBeVisible();
        await expect(page.getByLabel('Search pipelines')).toBeVisible();
        await expect(page.getByLabel('Status')).toBeVisible();
        await expect(page.getByText('Config editor')).toBeVisible();
        await expect(page.getByText('Versions & lifecycle')).toBeVisible();
    });

    test('the new-pipeline action opens the create dialog', async ({ page }) => {
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await page.getByRole('button', { name: 'New pipeline' }).first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText('New pipeline')).toBeVisible();
        await expect(dialog.getByLabel('Name')).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(page.getByRole('dialog')).toBeHidden();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
