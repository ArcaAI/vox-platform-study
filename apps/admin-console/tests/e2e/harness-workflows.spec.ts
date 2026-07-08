/**
 * Frame 38 — Harness workflows against a RUNNING stack (rule 12 gate 3):
 * screen smoke plus axe scans in both themes. Skips with actionable messages
 * when the app or gateway is down. The workflow list proxies to a
 * Temporal-backed service that may be down in local dev, so "settled" accepts
 * data rows, the empty state or the error card.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Harness workflows are tenant-scoped: elevated sessions see the
    // "Select a working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Harness Workflows' })).toBeVisible();
    // Data rows are focusable (row click -> detail); skeletons are not. When
    // Temporal is unreachable the grid renders the alert error card instead.
    const dataRows = page.getByRole('table', { name: 'Harness workflows' }).locator('tbody tr[tabindex="0"]');
    const emptyState = page.getByText('No harness workflows');
    const errorCard = page.getByRole('alert');
    await expect(dataRows.first().or(emptyState.first()).or(errorCard.first())).toBeVisible();
}

test.describe('harness workflows (frame 38)', () => {
    test('shows the header, filter strip and the fill-height grid', async ({ page }) => {
        // Redesign (TASK-441): the Detail and Signals-&-lifecycle side panels
        // moved into the detail slide-over (opened by selecting a workflow);
        // the grid is now primary and polls live while runs are RUNNING.
        await page.goto('/harness/workflows');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
        await expect(page.getByLabel('Search workflow id')).toBeVisible();
        await expect(page.getByRole('table', { name: 'Harness workflows' })).toBeVisible();
    });

    test('the state filter syncs to the URL', async ({ page }) => {
        await page.goto('/harness/workflows');
        await waitForSettled(page);
        await page.getByLabel('State:').click();
        await page.getByRole('option', { name: 'Running' }).click();
        await expect(page).toHaveURL(/state=RUNNING/);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/harness/workflows');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/harness/workflows');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});
