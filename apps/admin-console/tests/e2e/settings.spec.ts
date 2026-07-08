/**
 * Frame 24 — Settings & secrets screen spec (TASK-439 redesign): authenticated
 * smoke of the list (h1, New-setting action, data grid or empty state), the row →
 * DetailDrawer flow (Value/Details/History tabs, real value editor — no modal),
 * the create drawer, and the rule 11 §11 axe gate in both themes. Requires a
 * running stack.
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

async function waitForListSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Settings & secrets' })).toBeVisible();
    const grid = page.getByRole('grid', { name: 'Settings' });
    const emptyState = page.getByText('No settings yet').or(page.getByText('No settings match your search'));
    await expect(grid.or(emptyState.first())).toBeVisible();
}

/** True when at least one DATA row renders (waits out the skeleton; false on a true empty list). */
async function hasDataRows(page: Page): Promise<boolean> {
    return page
        .locator('[data-slot="data-grid-row"]')
        .first()
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
}

test.describe('settings & secrets screen (frame 24)', () => {
    test('shows the header, the New setting action and the grid or an empty state', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        await expect(page.getByRole('button', { name: 'New setting' }).first()).toBeVisible();
    });

    test('opens the create drawer from the New setting action', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        await page.getByRole('button', { name: 'New setting' }).first().click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('New setting')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Create setting' })).toBeVisible();
    });

    test('opens the detail drawer with tabs on row click (no modal editor)', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);

        // TASK-443 — group-header rows are non-interactive, so target a DATA row.
        test.skip(!(await hasDataRows(page)), 'no settings to open');
        await page.locator('[data-slot="data-grid-row"]').first().click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        // The drawer carries the Value/Details/History tabs — the value editor, not a modal.
        await expect(dialog.getByRole('tab', { name: 'Value' })).toBeVisible();
        await expect(dialog.getByRole('tab', { name: 'History' })).toBeVisible();
    });

    // TASK-443 — namespace grouping + Namespace/Type/Secrets-only chips.
    test('groups the list by namespace with header rows and offers the three faceting chips', async ({ page }) => {
        // Wide desktop: below a ~1024px grid container the chips collapse into the Filters control.
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto('/settings');
        await waitForListSettled(page);
        test.skip(!(await hasDataRows(page)), 'no settings to group');

        // Group-header rows (label + count) render between namespace sections.
        await expect(page.locator('[data-slot="data-grid-group-row"]').first()).toBeVisible();

        // The toolbar carries the Namespace / Type / Secrets chips (desktop = inline).
        for (const chip of ['Namespace', 'Type', 'Secrets']) {
            await expect(page.getByRole('button', { name: chip, exact: true })).toBeVisible();
        }
    });

    test('the Secrets-only chip narrows the server query via secretsOnly=true', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto('/settings');
        await waitForListSettled(page);
        test.skip(!(await hasDataRows(page)), 'no settings to filter');

        const secretsRequest = page.waitForRequest((request) => request.url().includes('/api/hope/admin/settings') && request.url().includes('secretsOnly=true'));
        await page.getByRole('button', { name: 'Secrets', exact: true }).click();
        await page.getByRole('radio', { name: 'Secrets only' }).click();

        const request = await secretsRequest;
        const url = new URL(request.url());
        expect(url.searchParams.get('secretsOnly')).toBe('true');
        // The derived predicate never rides the bracket grammar.
        expect(url.searchParams.get('filters')).toBeNull();

        // Result set is served masked — every visible row is a secret.
        await waitForListSettled(page);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/settings');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/settings');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });
});
