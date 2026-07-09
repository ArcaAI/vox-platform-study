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
    const dataRows = page.getByRole('grid', { name: 'Prompt templates' }).locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first()).or(page.getByRole("alert").first())).toBeVisible();
}

test.describe('agents & prompt templates (frame 32)', () => {
    test('shows the header, New action and the fill-height grid', async ({ page }) => {
        await page.goto('/agents');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'New template' }).first()).toBeVisible();
        await expect(page.getByRole('grid', { name: 'Prompt templates' })).toBeVisible();
    });

    test('a row opens the console-wide detail slide-over', async ({ page }) => {
        // Redesign (TASK-441): the former side panels are now a DetailDrawer
        // with Overview / Versions / Test-run tabs.
        await page.goto('/agents');
        await waitForSettled(page);
        await page.getByRole('grid', { name: 'Prompt templates' }).locator('[data-slot="data-grid-row"]').first().click();
        const drawer = page.getByRole('dialog');
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('tab', { name: 'Versions' })).toBeVisible();
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
