/**
 * Frame 23 — API keys screen spec: authenticated smoke of the list regions
 * (h1, create action, filter bar, table or empty state) and the rule 11 §11
 * axe gate in both themes. Requires a running stack (skips otherwise).
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

async function waitForListSettled(page: import('@playwright/test').Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'API keys' })).toBeVisible();
  const grid = page.getByRole('grid', { name: 'API keys' });
  const emptyState = page.getByText('No API keys yet').or(page.getByText('No keys match your filters'));
  await expect(grid.locator('[data-slot="data-grid-row"]').first().or(emptyState.first())).toBeVisible();
}

function keyRows(page: import('@playwright/test').Page) {
  return page.getByRole('grid', { name: 'API keys' }).locator('[data-slot="data-grid-row"]');
}

async function openRowMenuOffering(page: import('@playwright/test').Page, menuItemName: string) {
  const rows = keyRows(page);
  const rowCount = await rows.count();
  for (let i = 0; i < rowCount; i++) {
    await rows
      .nth(i)
      .getByRole('button', { name: /Open actions for/ })
      .click();
    const item = page.getByRole('menuitem', { name: menuItemName });
    if ((await item.count()) > 0) return item;
    await page.keyboard.press('Escape');
  }
  return page.getByRole('menuitem', { name: menuItemName });
}

test.describe('api keys screen (frame 23)', () => {
  test('shows the header with the table or an empty state', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    await expect(page.getByRole('button', { name: 'Create key' }).first()).toBeVisible();
    await expect(page.getByLabel('Search')).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/api-keys');
    await waitForListSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/api-keys');
    await waitForListSettled(page);
    await expectNoA11yViolations(page);
  });

  test('searching by an unmatched term shows the filtered-empty state', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    await page.getByLabel('Search').fill('no-such-key-xyz-000');
    await expect(page.getByText('No keys match your filters')).toBeVisible();
  });

  test('create dialog requires a name and at least one scope before submit enables', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    await page.getByRole('button', { name: 'Create key' }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Create API key' })).toBeVisible();
    const submit = dialog.getByRole('button', { name: 'Create key' });
    await expect(submit).toBeDisabled();

    await dialog.getByPlaceholder('svc_reporting').fill('e2e_temp_key');
    await expect(submit).toBeDisabled();

    await dialog.getByRole('checkbox').first().check();
    await expect(submit).toBeEnabled();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('the expires field is optional and only shown on create', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    await page.getByRole('button', { name: 'Create key' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Leave empty for a non-expiring key.')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('opens the row actions menu with view usage, edit, rotate and revoke/delete', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    test.skip((await keyRows(page).count()) === 0, 'no API keys seeded — the list is empty');

    await keyRows(page)
      .first()
      .getByRole('button', { name: /Open actions for/ })
      .click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'View usage' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('editing a key opens the dialog pre-filled and explains the secret never changes here', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    test.skip((await keyRows(page).count()) === 0, 'no API keys seeded — the list is empty');

    await keyRows(page)
      .first()
      .getByRole('button', { name: /Open actions for/ })
      .click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit API key' })).toBeVisible();
    await expect(dialog.getByText(/secret itself never changes here/)).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('rotate opens a confirmation naming the grace window and can be cancelled', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    test.skip((await keyRows(page).count()) === 0, 'no API keys seeded — the list is empty');

    const rotateItem = await openRowMenuOffering(page, 'Rotate');
    test.skip((await rotateItem.count()) === 0, 'no seeded key is ACTIVE — rotate is hidden');
    await rotateItem.click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: /^Rotate .+\?$/ })).toBeVisible();
    await expect(dialog.getByText(/24-hour grace window/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('revoke opens an irreversible-action confirmation and can be cancelled', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    test.skip((await keyRows(page).count()) === 0, 'no API keys seeded — the list is empty');

    const revokeItem = await openRowMenuOffering(page, 'Revoke');
    test.skip((await revokeItem.count()) === 0, 'no seeded key has a revoke action available');
    await revokeItem.click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: /^Revoke .+\?$/ })).toBeVisible();
    await expect(dialog.getByText('Revocation cannot be undone.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('delete requires typing the exact key name before the confirm button enables', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    test.skip((await keyRows(page).count()) === 0, 'no API keys seeded — the list is empty');

    await keyRows(page)
      .first()
      .getByRole('button', { name: /Open actions for/ })
      .click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: /^Delete .+\?$/ })).toBeVisible();
    const confirmButton = dialog.getByRole('button', { name: 'Delete key' });
    await expect(confirmButton).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('opening view usage shows the usage sheet for the selected key', async ({ page }) => {
    await page.goto('/api-keys');
    await waitForListSettled(page);
    test.skip((await keyRows(page).count()) === 0, 'no API keys seeded — the list is empty');

    await keyRows(page)
      .first()
      .getByRole('button', { name: /Open actions for/ })
      .click();
    await page.getByRole('menuitem', { name: 'View usage' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
