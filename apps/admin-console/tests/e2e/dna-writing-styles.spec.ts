/**
 * Frame 33 — DNA writing styles against a RUNNING stack (rule 12 gate 3):
 * screen smoke, one filter interaction, plus axe scans in both themes. Skips
 * with actionable messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // DNA writing styles is tenant-scoped (tier 30-49): elevated sessions see
    // the "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'DNA Writing Styles' })).toBeVisible();
    // Two empty variants: pristine ("No DNA reports yet") vs an active filter
    // ("No reports match your filters" — e.g. after toggling disabled=true).
    const emptyState = page.getByText(/No DNA reports yet|No reports match your filters/);
    // Data rows are focusable (row click -> doctor detail); skeleton rows are not.
    const dataRows = page.getByRole('grid', { name: 'DNA reports' }).locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first()).or(page.getByRole("alert").first())).toBeVisible();
}

test.describe('dna writing styles (frame 33)', () => {
    test('shows the header, dashboard roll-up strip and the fill-height grid', async ({ page }) => {
        // Redesign (TASK-441): the dashboard card is now the pinned `stats`
        // strip; the doctor detail (and its PHI caption) moved into the detail
        // slide-over, shown only when a doctor row is selected.
        await page.goto('/dna-writing-styles');
        await waitForSettled(page);
        await expect(page.getByRole('heading', { level: 2, name: 'Dashboard' })).toBeVisible();
        await expect(page.getByText('Doctors covered', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Generate report' }).first()).toBeVisible();
        await expect(page.getByRole('grid', { name: 'DNA reports' })).toBeVisible();
    });

    test('a doctor row opens the detail slide-over', async ({ page }) => {
        // Redesign (TASK-441): the doctor detail panel is now a DetailDrawer.
        await page.goto('/dna-writing-styles');
        await waitForSettled(page);
        const rows = page.getByRole('grid', { name: 'DNA reports' }).locator('[data-slot="data-grid-row"]');
        // Skip the interaction when the tenant has no reports (empty state).
        if ((await rows.count()) === 0) return;
        await rows.first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/dna-writing-styles');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/dna-writing-styles');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
