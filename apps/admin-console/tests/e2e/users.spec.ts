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
    return page.getByRole('table', { name: 'Users' }).locator('tbody tr[tabindex="0"]');
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
    await dataRows(page).first().click();
    await page.waitForURL('**/users/**');
}

test.describe('users list (frame 20)', () => {
    test('shows the header with the table or an empty state', async ({ page }) => {
        await page.goto('/users');
        await waitForListSettled(page);
        await expect(page.getByRole('button', { name: 'New user' }).first()).toBeVisible();
        await expect(page.getByLabel('Search users')).toBeVisible();
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
});

test.describe('user detail (frame 20.1)', () => {
    test('opens the first user and renders the header, actions and tabs', async ({ page }) => {
        await openFirstUser(page);

        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Impersonate' })).toBeVisible();
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
        await expect(page.getByText('Voice profiles', { exact: true })).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
