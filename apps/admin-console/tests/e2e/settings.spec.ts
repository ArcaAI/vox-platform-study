/**
 * Frame 24 — Settings & secrets screen spec: authenticated smoke of the list
 * (h1, New-setting action, data grid or empty state), the row →
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

        // Group-header rows are non-interactive, so target a DATA row.
        await expect(page.locator('[data-slot="data-grid-row"]').first()).toBeVisible();
        const grid = page.locator('[data-slot="virtualized-data-grid"] [role="grid"]');
        const heightBefore = await grid.evaluate((element) => element.getBoundingClientRect().height);
        expect(heightBefore).toBeGreaterThan(0);

        await page.locator('[data-slot="data-grid-row"]').first().click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        // Opening the detail drawer must not reduce the underlying table's fill height.
        const heightAfter = await grid.evaluate((element) => element.getBoundingClientRect().height);
        expect(heightAfter).toBeGreaterThanOrEqual(heightBefore - 1);
        // The drawer carries the Value/Details/History tabs — the value editor, not a modal.
        await expect(dialog.getByRole('tab', { name: 'Value' })).toBeVisible();
        await expect(dialog.getByRole('tab', { name: 'History' })).toBeVisible();
    });

    // Namespace grouping + Namespace/Type/Secrets-only chips.
    test('groups the list by namespace with header rows and offers the three faceting chips', async ({ page }) => {
        // Wide desktop: below a ~1024px grid container the chips collapse into the Filters control.
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto('/settings');
        await waitForListSettled(page);
        await expect(page.locator('[data-slot="data-grid-row"]').first()).toBeVisible();

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
        await expect(page.locator('[data-slot="data-grid-row"]').first()).toBeVisible();

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

    test('searching by an unmatched term shows the filtered-empty state', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        await page.getByLabel('Search').fill('no-such-setting-xyz-000');
        await expect(page.getByText('No settings match your search')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
    });

    test('create dialog requires name and key before submit enables', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        await page.getByRole('button', { name: 'New setting' }).first().click();

        const dialog = page.getByRole('dialog');
        const submit = dialog.getByRole('button', { name: 'Create setting' });
        await expect(submit).toBeDisabled();

        await dialog.getByRole('tab', { name: 'Details' }).press('Enter');
        await expect(dialog.getByRole('tabpanel', { name: 'Details' })).toBeVisible();
        await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E temp setting');
        await expect(submit).toBeDisabled();

        await dialog.getByPlaceholder('smtp.host').fill('e2e.temp.key');
        await expect(submit).toBeEnabled();

        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
    });

    test('the type select offers the documented data types', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        await page.getByRole('button', { name: 'New setting' }).first().click();
        const dialog = page.getByRole('dialog');

        await dialog.getByRole('combobox', { name: 'Type' }).click();
        for (const type of ['String', 'Integer', 'Boolean', 'Json']) {
            await expect(page.getByRole('option', { name: type })).toBeVisible();
        }
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
    });

    test('opening a row shows the value editor and a Save changes affordance', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        await expect(page.locator('[data-slot="data-grid-row"]').first()).toBeVisible();

        await page.locator('[data-slot="data-grid-row"]').first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('tab', { name: 'Value' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeVisible();
        await page.keyboard.press('Escape');
    });

    test('non-secret settings do not expose secret reveal controls', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        const maskedCell = page.getByText('Secret value hidden', { exact: false });

        if (await maskedCell.count()) {
            await maskedCell.first().locator('xpath=ancestor::*[@data-slot="data-grid-row"]').click();
            const drawer = page.getByRole('dialog');
            const revealButton = drawer.getByRole('button', { name: /^Reveal/ });
            await expect(revealButton).toHaveCount(1);
            await revealButton.click();
            const dialog = page.getByRole('dialog').filter({ hasText: 'Reveal secret' });
            await expect(dialog.getByRole('heading', { name: 'Reveal secret' })).toBeVisible();
            await expect(dialog.getByText(/Every reveal is audit-logged/)).toBeVisible();
            const submit = dialog.getByRole('button', { name: 'Reveal secret' });
            await expect(submit).toBeDisabled();

            await dialog.getByLabel('Password').fill('wrong-password-e2e');
            await expect(submit).toBeEnabled();

            await page.keyboard.press('Escape');
            await expect(dialog).not.toBeVisible();
        } else {
            await page.locator('[data-slot="data-grid-row"]').first().click();
            const drawer = page.getByRole('dialog');
            await expect(drawer.getByRole('button', { name: /^Reveal/ })).toHaveCount(0);
            await expect(drawer.getByRole('button', { name: 'Rotate' })).toHaveCount(0);
            await page.keyboard.press('Escape');
        }
    });

    test('secret values are masked with a screen-reader label when present', async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto('/settings');
        await waitForListSettled(page);
        const maskedCell = page.getByText('Secret value hidden', { exact: false });

        if (await maskedCell.count()) {
            await expect(maskedCell.first().locator('xpath=preceding-sibling::*[@aria-hidden="true"][1]')).toBeVisible();
        } else {
            await expect(page.getByRole('button', { name: 'Secrets', exact: true })).toBeVisible();
            await expect(page.getByText('secrets masked — reveal is audited')).toBeVisible();
        }
    });


    test('delete opens a confirmation naming fallback-to-default behavior and can be cancelled', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        await expect(page.locator('[data-slot="data-grid-row"]').first()).toBeVisible();

        await page.locator('[data-slot="data-grid-row"]').first().getByRole('button', { name: /^Delete / }).click();
        const dialog = page.getByRole('alertdialog');
        await expect(dialog.getByRole('heading', { name: /^Delete .+\?$/ })).toBeVisible();
        await expect(dialog.getByText(/Consumers fall back to their built-in default/)).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).not.toBeVisible();
    });
    test('locked settings show a lock indicator when present', async ({ page }) => {
        await page.goto('/settings');
        await waitForListSettled(page);
        const lockedIndicator = page.locator('.sr-only').filter({ hasText: 'locked' }).first();

        if (await lockedIndicator.count()) {
            const lockedRow = lockedIndicator.locator('xpath=ancestor::*[@data-slot="data-grid-row"]');
            await lockedRow.scrollIntoViewIfNeeded();
            await expect(lockedRow).toBeVisible();
            await expect(lockedIndicator).toBeAttached();
            await expect(lockedRow.locator('[aria-hidden="true"]').first()).toBeVisible();
        } else {
            await expect(page.getByRole('grid', { name: 'Settings' })).toBeVisible();
        }
    });

});
