/**
 * Frame 21 — RBAC Roles two-pane redesign (TASK-438). Authenticated smoke of
 * the grouped role list, list→select→permission-matrix, system-role lockdown,
 * the break-glass delete cancelled path, and the rule 11 §11 axe gate in both
 * themes. Requires a running stack (skips otherwise, see helpers/stack.ts).
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

/** The grouped role-list panel (aria-labelled "Roles") and its selectable items. */
function roleListItems(page: Page) {
    return page.locator('div[aria-label="Roles"] ul button');
}

async function waitForList(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Roles' })).toBeVisible();
    await expect(page.getByLabel('Search roles')).toBeVisible();
    // System roles are always seeded, so at least one list item is present.
    await expect(roleListItems(page).first()).toBeVisible();
}

test.describe('RBAC roles screen (two-pane)', () => {
    test('renders the heading, search, create action and the select-a-role prompt', async ({ page }) => {
        await page.goto('/rbac/roles');
        await waitForList(page);
        await expect(page.getByRole('button', { name: 'New role' }).first()).toBeVisible();
        await expect(page.getByText('Select a role')).toBeVisible();
        await expect(page.getByText(/System · locked/i)).toBeVisible();
    });

    test('selecting a role renders its derived permission matrix', async ({ page }) => {
        await page.goto('/rbac/roles');
        await waitForList(page);
        await roleListItems(page).first().click();

        // The detail header h2 (role name) — scoped away from the ⌘K command
        // palette's own level-2 dialog title, which is also mounted in the DOM.
        await expect(page.getByRole('heading', { level: 2 }).and(page.locator(':not([data-slot="dialog-title"])'))).toBeVisible();
        // Desktop tier (1280 viewport) renders the matrix as a table with a legend.
        await expect(page.getByRole('table')).toBeVisible();
        await expect(page.getByRole('list', { name: 'Legend' })).toBeVisible();
        await expect(page).toHaveURL(/role=/);
    });

    test('system roles are locked: no Edit or Delete affordances', async ({ page }) => {
        await page.goto('/rbac/roles');
        await waitForList(page);
        // The first group is System · locked.
        await roleListItems(page).first().click();
        await expect(page.getByText('System (locked)')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    });

    test('delete on a custom role opens the break-glass step-up and can be cancelled', async ({ page }) => {
        await page.goto('/rbac/roles');
        await waitForList(page);

        // Custom roles are optional in a fresh tenant; find one via its Delete affordance.
        const items = roleListItems(page);
        const count = await items.count();
        let deletable = false;
        for (let index = 0; index < count; index += 1) {
            await items.nth(index).click();
            if (await page.getByRole('button', { name: 'Delete' }).isVisible().catch(() => false)) {
                deletable = true;
                break;
            }
        }
        test.skip(!deletable, 'No custom (deletable) role seeded in this environment.');

        await page.getByRole('button', { name: 'Delete' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText('Delete role')).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        // The role list is still present after cancelling (no destructive call made).
        await expect(roleListItems(page).first()).toBeVisible();
    });

    test('Members tab lists role holders (or an honest empty state) with a header count chip', async ({ page }) => {
        await page.goto('/rbac/roles');
        await waitForList(page);
        await roleListItems(page).first().click();

        // TASK-444 — the role reads now carry memberCount; the detail header
        // renders it as an accessible badge ("N member(s)").
        await expect(page.getByText(/\d+ members?/).first()).toBeVisible();

        await page.getByRole('tab', { name: 'Members' }).click();
        // Seeded system roles have at least one holder in a dev stack, but a
        // scoped tenant may legitimately see none — accept either the list or
        // the tenant-scoped empty state (never the old "isn't available yet").
        await expect(page.getByRole('list', { name: 'Role members' }).or(page.getByText('No members yet')).first()).toBeVisible();
        await expect(page.getByText('Member listing isn’t available yet')).toHaveCount(0);
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/rbac/roles');
        await waitForList(page);
        await roleListItems(page).first().click();
        await expect(page.getByRole('table')).toBeVisible();
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/rbac/roles');
        await waitForList(page);
        await roleListItems(page).first().click();
        await expect(page.getByRole('table')).toBeVisible();
        await expectNoA11yViolations(page);
    });
});
