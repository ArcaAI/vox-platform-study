/**
 * Frames 12 / 12.1 — tenants list + detail against a RUNNING stack (rule 12
 * gate 3): screen smoke plus axe scans in both themes. Skips with actionable
 * messages when the app or gateway is down.
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
});

/** Data rows are focusable (row click); skeleton rows are not. */
function dataRows(page: import('@playwright/test').Page) {
    return page.getByRole('grid', { name: 'Tenants' }).locator('[data-slot="data-grid-row"]');
}

async function waitForListSettled(page: import('@playwright/test').Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Tenants' })).toBeVisible();
    const emptyState = page.getByText('No tenants yet').or(page.getByText('No tenants match your filters'));
    await expect(dataRows(page).first().or(emptyState.first())).toBeVisible();
}

test.describe('tenants list (frame 12)', () => {
    test('shows the header with the table or an empty state', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        await expect(page.getByRole('button', { name: 'New tenant' }).first()).toBeVisible();
        await expect(page.getByLabel('Search')).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/tenants');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/tenants');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });

    test('creates a new tenant through the three-step wizard, picking an existing user as admin', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        const tenantName = `e2e-test-${Date.now()}`;
        const tenantKey = `e2e-test-key-${Date.now()}`;

        const existingUser = await page.evaluate(async () => {
            const res = await fetch('/api/hope/admin/users?page=0&limit=1');
            if (!res.ok) return null;
            const body = (await res.json()) as { data?: Array<{ id: string; username: string }> };
            return body.data?.[0] ?? null;
        });
        test.skip(!existingUser, 'no seeded users — cannot exercise the existing-user admin path');

        await page.getByRole('button', { name: 'New tenant' }).first().click();
        const dialog = page.getByRole('dialog', { name: 'New tenant' });

        await expect(dialog.getByText('Step 1 of 3')).toBeVisible();
        await dialog.getByLabel('Name').fill(tenantName);
        await dialog.getByLabel('Key').fill(tenantKey);
        await dialog.getByRole('button', { name: 'Next' }).click();

        await expect(dialog.getByText('Step 2 of 3')).toBeVisible();
        await dialog.getByRole('radio', { name: /^Enterprise/ }).check();
        await dialog.getByRole('button', { name: 'Next' }).click();

        await expect(dialog.getByText('Step 3 of 3')).toBeVisible();
        await dialog.getByRole('radio', { name: 'Use an existing user' }).check();
        await dialog.getByRole('combobox', { name: /search by username/i }).click();
        await page.getByPlaceholder('Search users by username…').fill((existingUser as { username: string }).username);
        await page.getByRole('option', { name: (existingUser as { username: string }).username }).click();
        await dialog.getByRole('button', { name: 'Create tenant' }).click();
        await expect(dialog).toBeHidden();

        await page.waitForURL('**/tenants/**');
        await expect(page.getByRole('heading', { level: 1, name: tenantName })).toBeVisible();
        await expect(page.getByLabel('Overview').getByText('Enterprise')).toBeVisible();
    });

    test('creates a new tenant with a brand-new local user as admin', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        const stamp = Date.now();
        const tenantName = `e2e-test-${stamp}`;
        const tenantKey = `e2e-test-key-${stamp}`;

        await page.getByRole('button', { name: 'New tenant' }).first().click();
        const dialog = page.getByRole('dialog', { name: 'New tenant' });

        await expect(dialog.getByText('Step 1 of 3')).toBeVisible();
        await dialog.getByLabel('Name').fill(tenantName);
        await dialog.getByLabel('Key').fill(tenantKey);
        await dialog.getByRole('button', { name: 'Next' }).click();

        await expect(dialog.getByText('Step 2 of 3')).toBeVisible();
        await dialog.getByRole('radio', { name: /^Pro/ }).check();
        await dialog.getByRole('button', { name: 'Next' }).click();

        await expect(dialog.getByText('Step 3 of 3')).toBeVisible();
        await dialog.getByRole('radio', { name: 'Create a new local user' }).check();
        await dialog.getByLabel('Email').fill(`${tenantKey}@e2e.test`);
        await dialog.getByLabel('Password').fill('E2e-test-password-1!');
        await dialog.getByRole('button', { name: 'Create tenant' }).click();
        await expect(dialog).toBeHidden();

        await page.waitForURL('**/tenants/**');
        await expect(page.getByRole('heading', { level: 1, name: tenantName })).toBeVisible();
        await expect(page.getByLabel('Overview').getByText('Pro')).toBeVisible();
    });

    test('searches the list down to a matching tenant', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        const rows = dataRows(page);
        const rowCount = await rows.count();
        test.skip(rowCount === 0, 'no tenants seeded — the list is empty');
        const firstName = (await rows.first().locator('[role="gridcell"]').first().innerText()).trim();

        await page.getByLabel('Search tenants').fill(firstName);
        await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
        const filteredRows = dataRows(page);
        await expect(filteredRows.first()).toContainText(firstName);
        await expect(async () => {
            const rowTexts = await filteredRows.allInnerTexts();
            for (const text of rowTexts) {
                expect(text).toContain(firstName);
            }
        }).toPass();
    });

    test('filters by status and offers clear filters', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        const rowCount = await dataRows(page).count();
        test.skip(rowCount === 0, 'no tenants seeded — the list is empty');

        await page.getByRole('button', { name: 'Filters' }).click();
        await page.getByRole('option', { name: 'Suspended' }).click();
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
        const clearFilters = page.getByRole('button', { name: 'Clear filters' });
        const emptyMatch = page.getByText('No tenants match your filters');
        await expect(clearFilters.or(emptyMatch).first()).toBeVisible();
    });

    test('opens the row action menu and offers a cancel-only lifecycle confirm', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        const rows = dataRows(page);
        const rowCount = await rows.count();
        test.skip(rowCount === 0, 'no tenants seeded — the list is empty');

        const tenantName = (await rows.first().locator('[role="gridcell"]').first().innerText()).trim();
        await rows.first().getByRole('button', { name: `Open actions for ${tenantName}` }).click();
        await expect(page.getByRole('menuitem', { name: 'View' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();

        const reversibleAction = page.getByRole('menuitem', { name: /^(Suspend|Restore|Archive)$/ });
        const actionCount = await reversibleAction.count();
        test.skip(actionCount === 0, 'no reversible lifecycle action available for this tenant status');
        const actionLabel = (await reversibleAction.first().innerText()).trim();
        await reversibleAction.first().click();
        const dialog = page.getByRole('alertdialog', { name: `${actionLabel} ${tenantName}?` });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
    });
});

test.describe('tenant detail (frame 12.1)', () => {
    test('opens the first tenant and renders the header, tabs and overview', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        test.skip((await dataRows(page).count()) === 0, 'no tenants seeded — the list is empty');

        await dataRows(page).first().click();
        await page.waitForURL('**/tenants/**');

        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('tablist')).toBeVisible();
        for (const name of ['Overview', 'Usage', 'Configs', 'Tags', 'Frontend config']) {
            await expect(page.getByRole('tab', { name })).toBeVisible();
        }
        await expect(page.getByText('Tenant ID')).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('switching to the usage tab syncs the URL and loads the stats', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        test.skip((await dataRows(page).count()) === 0, 'no tenants seeded — the list is empty');

        await dataRows(page).first().click();
        await page.waitForURL('**/tenants/**');
        await page.getByRole('tab', { name: 'Usage' }).click();
        await expect(page).toHaveURL(/tab=usage/);
        await expect(page.getByText('Storage used')).toBeVisible();
    });

    test('the configs, tags and frontend config tabs render real content', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        test.skip((await dataRows(page).count()) === 0, 'no tenants seeded — the list is empty');

        await dataRows(page).first().click();
        await page.waitForURL('**/tenants/**');

        await page.getByRole('tab', { name: 'Configs' }).click();
        await expect(page).toHaveURL(/tab=configs/);
        const configsEmptyState = page.getByText('No configs for this tenant');
        const saveButtons = page.getByRole('button', { name: /^Save / });
        await expect(configsEmptyState.or(saveButtons.first())).toBeVisible();

        await page.getByRole('tab', { name: 'Tags' }).click();
        await expect(page).toHaveURL(/tab=tags/);
        await expect(page.getByLabel('New tag')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Add tag' })).toBeVisible();

        await page.getByRole('tab', { name: 'Frontend config' }).click();
        await expect(page).toHaveURL(/tab=frontend-config/);
    });

    test('adds and removes a tag on the tags tab', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        test.skip((await dataRows(page).count()) === 0, 'no tenants seeded — the list is empty');

        await dataRows(page).first().click();
        await page.waitForURL('**/tenants/**');
        await page.getByRole('tab', { name: 'Tags' }).click();
        await expect(page).toHaveURL(/tab=tags/);

        const tag = `e2e-test-${Date.now()}`;
        await page.getByLabel('New tag').fill(tag);
        await page.getByRole('button', { name: 'Add tag' }).click();
        await expect(page.getByText(tag, { exact: true })).toBeVisible();

        await page.getByRole('button', { name: `Remove tag ${tag}` }).click();
        await expect(page.getByText(tag, { exact: true })).toBeHidden();
    });

    test('lifecycle actions in the detail header offer a cancel-only confirm', async ({ page }) => {
        await page.goto('/tenants');
        await waitForListSettled(page);
        const rows = dataRows(page);
        test.skip((await rows.count()) === 0, 'no tenants seeded — the list is empty');

        await rows.first().click();
        await page.waitForURL('**/tenants/**');
        const heading = page.getByRole('heading', { level: 1 });
        const tenantName = (await heading.innerText()).trim();

        const reversibleAction = page.getByRole('button', { name: /^(Suspend|Restore|Archive)$/ });
        const actionCount = await reversibleAction.count();
        test.skip(actionCount === 0, 'no reversible lifecycle action available for this tenant status');
        const actionLabel = (await reversibleAction.first().innerText()).trim();
        await reversibleAction.first().click();
        const dialog = page.getByRole('alertdialog', { name: `${actionLabel} ${tenantName}?` });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
    });

    test('shows a 404 state and a back link for a nonexistent tenant id', async ({ page }) => {
        await page.goto('/tenants/ffffffff-ffff-ffff-ffff-ffffffffffff');
        await expect(page.getByText('Tenant not found')).toBeVisible();
        const backLink = page.getByRole('button', { name: 'Back to tenants' });
        await expect(backLink).toBeVisible();
        await backLink.click();
        await page.waitForURL('**/tenants');
        await expect(page.getByRole('heading', { level: 1, name: 'Tenants' })).toBeVisible();
    });
});
