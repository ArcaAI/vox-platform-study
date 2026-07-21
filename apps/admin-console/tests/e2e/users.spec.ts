/**
 * Frames 20 / 20.1 — users list + detail against a RUNNING stack (rule 12
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
    return page.getByRole('grid', { name: 'Users' }).locator('[data-slot="data-grid-row"]');
}

async function waitForListSettled(page: import('@playwright/test').Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    const emptyState = page.getByText('No users yet').or(page.getByText('No users match your filters'));
    await expect(dataRows(page).first().or(emptyState.first())).toBeVisible();
}

async function openFirstUser(page: import('@playwright/test').Page) {
    await page.goto('/users');
    await waitForListSettled(page);
    test.skip((await dataRows(page).count()) === 0, 'no users seeded — the list is empty');
    await page.getByLabel('Search').fill('super_admin');
    const row = dataRows(page).filter({ hasText: 'super_admin' }).first();
    await expect(row).toBeVisible();
    await row.click();
    await page.waitForURL(/\/users\/[^/?]+/);
}

test.describe('users list (frame 20)', () => {
    test('shows the header with the table or an empty state', async ({ page }) => {
        await page.goto('/users');
        await waitForListSettled(page);
        await expect(page.getByRole('button', { name: 'New user' }).first()).toBeVisible();
        await expect(page.getByLabel('Search')).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/users');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/users');
        await waitForListSettled(page);
        await expectNoA11yViolations(page);
    });

    test('the create dialog requires a username and password before submit enables', async ({ page }) => {
        await page.goto('/users');
        await waitForListSettled(page);
        await page.getByRole('button', { name: 'New user' }).first().click();

        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('heading', { name: 'New user' })).toBeVisible();
        const submit = dialog.getByRole('button', { name: 'Create user' });
        await expect(submit).toBeDisabled();

        await dialog.getByRole('textbox', { name: 'Username' }).fill('e2e_temp_user');
        await expect(submit).toBeDisabled();

        await dialog.getByRole('textbox', { name: 'Password' }).fill('temp-password');
        await expect(submit).toBeEnabled();

        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
    });

    test('selecting a row reveals the bulk actions toolbar, which can be dismissed', async ({ page }) => {
        await page.goto('/users');
        await waitForListSettled(page);
        test.skip((await dataRows(page).count()) === 0, 'no users seeded — the list is empty');

        await dataRows(page).first().getByRole('checkbox', { name: 'Select row' }).check();
        const toolbar = page.getByRole('toolbar', { name: 'Bulk actions' });
        await expect(toolbar).toBeVisible();
        await expect(toolbar.getByText('1 selected')).toBeVisible();
        await expect(toolbar.getByRole('button', { name: 'Enable' })).toBeVisible();
        await expect(toolbar.getByRole('button', { name: 'Disable' })).toBeVisible();
        await expect(toolbar.getByRole('button', { name: 'Delete' })).toBeVisible();
        await expect(toolbar.getByRole('button', { name: 'Export' })).toBeVisible();

        await toolbar.getByRole('button', { name: 'Clear selection' }).click();
        await expect(toolbar).toBeHidden();
    });

    test('a bulk enable/disable action opens a confirm dialog naming the selection, and can be cancelled', async ({ page }) => {
        await page.goto('/users');
        await waitForListSettled(page);
        test.skip((await dataRows(page).count()) === 0, 'no users seeded — the list is empty');

        await dataRows(page).first().getByRole('checkbox', { name: 'Select row' }).check();
        await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Disable' }).click();

        const dialog = page.getByRole('alertdialog');
        await expect(dialog.getByRole('heading', { name: 'Disable 1 user?' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).not.toBeVisible();
        await expect(page.getByRole('toolbar', { name: 'Bulk actions' })).toBeVisible();
    });
});

test.describe('user detail (frame 20.1)', () => {
    test('opens the first user and renders the header, actions and tabs', async ({ page }) => {
        await openFirstUser(page);

        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        // Impersonate is hidden for service accounts and the seeded first
        // user may be one, so assert the always-present Reset password action.
        await expect(page.getByRole('button', { name: 'Reset password' })).toBeVisible();
        await expect(page.getByRole('tablist')).toBeVisible();
        for (const name of ['Roles', 'Departments', 'Settings', 'Profile', 'Security']) {
            await expect(page.getByRole('tab', { name })).toBeVisible();
        }
        await expectNoA11yViolations(page);
    });

    test('switching to the profile tab syncs the URL and loads the form', async ({ page }) => {
        await openFirstUser(page);

        await page.getByRole('tab', { name: 'Profile' }).click();
        await expect(page).toHaveURL(/tab=profile/);
        await expect(page.getByLabel('First name')).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations on the security tab (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await openFirstUser(page);

        await page.getByRole('tab', { name: 'Security' }).click();
        await expect(page).toHaveURL(/tab=security/);
        // exact: the empty state right below is titled "No voice profiles".
        await expect(page.getByRole('tabpanel').getByText('Voice profiles', { exact: true })).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('reset password from the security tab shows a confirm, then the one-time secret', async ({ page }) => {
        await openFirstUser(page);

        await page.getByRole('tab', { name: 'Security' }).click();
        await expect(page).toHaveURL(/tab=security/);

        await page.getByRole('button', { name: 'Reset password' }).first().click();

        const confirmDialog = page.getByRole('alertdialog');
        await expect(confirmDialog.getByRole('heading', { name: /^Reset password for /i })).toBeVisible();
        await confirmDialog.getByRole('button', { name: 'Reset password' }).click();

        const resultDialog = page.getByRole('dialog').filter({ hasText: 'Share it with the user out-of-band' });
        await expect(resultDialog).toBeVisible();
        await expect(resultDialog.getByRole('button', { name: 'Copy reset secret' })).toBeVisible();
        await resultDialog.getByRole('button', { name: 'Done' }).click();
        await expect(resultDialog).not.toBeVisible();
    });
});
