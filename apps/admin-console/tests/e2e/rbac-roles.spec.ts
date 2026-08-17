/**
 * Frame 21 — RBAC Roles two-pane layout. Authenticated smoke of the grouped
 * role list, list→select→permission-matrix, system-role lockdown,
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
function customRoleItems(page: Page) {
  return page
    .getByText(/^Custom \(\d+\)$/)
    .locator('..')
    .getByRole('list')
    .getByRole('button');
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

  test('system roles allow super-admin editing but never deletion', async ({ page }) => {
    await page.goto('/rbac/roles');
    await waitForList(page);
    await roleListItems(page).first().click();
    await expect(page.getByText('System (locked)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });

  test('delete on a custom role opens the break-glass step-up and can be cancelled', async ({ page }) => {
    await page.goto('/rbac/roles');
    await waitForList(page);

    const items = customRoleItems(page);
    await expect(items.first()).toBeVisible();
    await items.first().click();

    await page.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Delete role' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(roleListItems(page).first()).toBeVisible();
  });

  test('Members tab lists role holders (or an honest empty state) with a header count chip', async ({ page }) => {
    await page.goto('/rbac/roles');
    await waitForList(page);
    await roleListItems(page).first().click();

    // Role reads carry memberCount; the detail header renders it as an
    // accessible badge ("N member(s)").
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
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/rbac/roles');
    await waitForList(page);
    await expectNoA11yViolations(page);
  });

  test('searching by an unmatched term shows the filtered-empty state', async ({ page }) => {
    await page.goto('/rbac/roles');
    await waitForList(page);
    await page.getByLabel('Search roles').fill('no-such-role-xyz-000');
    await expect(page.getByText('No roles match “no-such-role-xyz-000”.')).toBeVisible();
  });

  test('opening the create dialog disables submit until a name is entered', async ({ page }) => {
    await page.goto('/rbac/roles');
    await page.getByRole('button', { name: 'New role' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New role' })).toBeVisible();
    const submit = dialog.getByRole('button', { name: 'Create role' });
    await expect(submit).toBeDisabled();

    await dialog.getByPlaceholder('Auditor').fill('E2E temp role');
    await expect(submit).toBeEnabled();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('opens a custom role and can cancel an edit without saving', async ({ page }) => {
    await page.goto('/rbac/roles');
    await waitForList(page);

    const items = customRoleItems(page);
    await expect(items.first()).toBeVisible();
    await items.first().click();

    await page.getByRole('button', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit role' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('attach-policy select is available on a custom role and detach requires break-glass confirmation', async ({ page }) => {
    await page.goto('/rbac/roles');
    await waitForList(page);

    const items = customRoleItems(page);
    await expect(items.first()).toBeVisible();
    await items.first().click();

    await page.getByRole('tab', { name: 'Policies' }).click();
    await expect(page.getByRole('combobox', { name: 'Policy to attach' })).toBeVisible();

    const detachButton = page.getByRole('button', { name: /^Detach / }).first();
    if ((await detachButton.count()) > 0) {
      await detachButton.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Detach policy' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
    }
  });
});
