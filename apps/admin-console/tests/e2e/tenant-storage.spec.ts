/**
 * Frame 14 — Tenant storage administration against a RUNNING stack (rule 12
 * gate 3): screen smoke plus axe scans in both themes. Skips with actionable
 * messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // Storage administration is tenant-scoped: elevated sessions see the
  // "Select a working tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Tenant Storage Administration' })).toBeVisible();
  const emptyState = page.getByText('No buckets provisioned yet');
  // Data rows are focusable (row click -> object browser); skeleton rows are not.
  const dataRows = page.getByRole('grid', { name: 'Tenant buckets' }).locator('[data-slot="data-grid-row"]');
  await expect(dataRows.first().or(emptyState.first())).toBeVisible();
}

function dataRows(page: Page) {
  return page.getByRole('grid', { name: 'Tenant buckets' }).locator('[data-slot="data-grid-row"]');
}

async function fetchSeededTenant(page: Page): Promise<{ id: string; name?: string } | null> {
  return page.evaluate(async () => {
    const list = await fetch('/api/hope/admin/tenants?page=0&limit=20');
    if (!list.ok) return null;
    const body = (await list.json()) as { data?: Array<{ id: string; name?: string }> };
    return body.data?.find((tenant) => !tenant.id.startsWith('00000000')) ?? null;
  });
}

test.describe('tenant storage (frame 14)', () => {
  test('shows the header, tabs and the buckets region', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    for (const name of ['Buckets', 'Defaults', 'Configs', 'Access keys']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Provision buckets' }).first()).toBeVisible();
    await expect(page.getByLabel('Search')).toBeVisible();
  });

  test('provisioning buckets for a seeded tenant succeeds', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    const tenant = await fetchSeededTenant(page);
    expect(tenant, 'No customer tenant seeded; cannot provision buckets').toBeTruthy();

    await page.getByRole('button', { name: 'Provision buckets' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Provision tenant buckets' });
    await expect(dialog).toBeVisible();

    const submit = dialog.getByRole('button', { name: 'Provision' });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel('Tenant ID').fill(tenant.id);
    await expect(submit).toBeEnabled();
    const provisionResponse = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes(`/buckets/provision/${tenant.id}`),
    );
    await submit.click();
    await expect((await provisionResponse).status()).toBe(201);

    await expect(dialog).toBeHidden();
    await expect(page.getByText(/buckets provisioned/)).toBeVisible();
  });

  test('the buckets grid filters by purpose', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    expect(await dataRows(page).count(), 'No seeded tenant buckets available for filtering').toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Filters', exact: true }).click();

    // Derive the purpose from the facet itself. This hardcoded "Audio", which no
    // seeded bucket carries, so the option never rendered and the click timed out —
    // the same brittleness as a hardcoded department name. The behaviour under test
    // is that filtering by A purpose narrows the grid to that purpose.
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible();
    const purpose = ((await options.first().textContent()) ?? '').trim();
    expect(purpose, 'the purpose facet offered no options').not.toBe('');
    await options.first().click();
    await page.keyboard.press('Escape');

    const rows = dataRows(page);
    const emptyState = page.getByText('No buckets match your filters');
    await expect(rows.first().or(emptyState).first()).toBeVisible();
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      await expect(rows.nth(index)).toContainText(purpose);
    }
  });

  test('clicking a bucket row opens the object browser sheet', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    const rows = dataRows(page);
    expect(await rows.count(), 'No seeded tenant buckets available for browsing').toBeGreaterThan(0);

    const firstRowName = await rows.first().locator('.font-medium').first().innerText();
    await rows.first().click();

    const sheet = page.getByRole('dialog').filter({ hasText: firstRowName });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('navigation', { name: 'Object prefix' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
  });

  test("a row's actions menu can browse objects", async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    const rows = dataRows(page);
    expect(await rows.count(), 'No seeded tenant buckets available for actions').toBeGreaterThan(0);

    const firstRowName = await rows.first().locator('.font-medium').first().innerText();
    await rows
      .first()
      .getByRole('button', { name: /^Open actions for/ })
      .click();
    await page.getByRole('menuitem', { name: 'Browse objects' }).click();

    const sheet = page.getByRole('dialog').filter({ hasText: firstRowName });
    await expect(sheet).toBeVisible();
  });

  test('deleting a bucket requires typing the exact slug before confirming, then cancels', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    const rows = dataRows(page);
    expect(await rows.count(), 'No seeded tenant buckets available for deletion').toBeGreaterThan(0);

    const firstRowSlug = await rows.first().locator('.font-mono.text-xs').first().innerText();
    await rows
      .first()
      .getByRole('button', { name: /^Open actions for/ })
      .click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Delete bucket?' });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Delete bucket' });
    await expect(confirm).toBeDisabled();

    await dialog.getByLabel(`Type ${firstRowSlug} to confirm`).fill(firstRowSlug);
    await expect(confirm).toBeEnabled();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(rows.first()).toBeVisible();
  });

  test('the defaults tab renders the purpose-to-bucket form', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    await page.getByRole('tab', { name: 'Defaults' }).click();
    await expect(page).toHaveURL(/tab=defaults/);
    await expect(page.getByRole('heading', { name: 'Default buckets by purpose' })).toBeVisible();
    await expect(page.getByLabel('Audio default')).toBeVisible();
  });

  test('the configs tab renders the storage configs region', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    await page.getByRole('tab', { name: 'Configs' }).click();
    await expect(page).toHaveURL(/tab=configs/);
    await expect(page.getByRole('grid', { name: 'Storage configs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add config' })).toBeVisible();
  });

  test('the access-keys tab syncs the URL and renders its region', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    await page.getByRole('tab', { name: 'Access keys' }).click();
    await expect(page).toHaveURL(/tab=keys/);
    await expect(page.getByRole('button', { name: 'Create access key' }).first()).toBeVisible();
  });

  test('the create access key dialog validates the name and can be cancelled', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    await page.getByRole('tab', { name: 'Access keys' }).click();

    await page.getByRole('button', { name: 'Create access key' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create access key' });
    await expect(dialog).toBeVisible();

    const submit = dialog.getByRole('button', { name: 'Create key' });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel('Name', { exact: true }).fill('e2e-cancelled-key');
    await expect(submit).toBeEnabled();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('creating an access key reveals the secret once, then the key is usable and deletable', async ({ page }) => {
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    await page.getByRole('tab', { name: 'Access keys' }).click();

    const keyName = `e2e-created-key-${Date.now()}`;
    await page.getByRole('button', { name: 'Create access key' }).first().click();
    const createDialog = page.getByRole('dialog', { name: 'Create access key' });
    await createDialog.getByLabel('Name', { exact: true }).fill(keyName);
    await createDialog.getByRole('button', { name: 'Create key' }).click();

    const secretDialog = page.getByRole('dialog', { name: 'Access key created' });
    await expect(secretDialog).toBeVisible();
    await expect(secretDialog.getByText(/won.t be shown again/)).toBeVisible();

    const accessKeyId = await secretDialog.locator('span.font-mono').first().innerText();
    const secretAccessKey = await secretDialog.locator('span.font-mono').nth(1).innerText();
    expect(accessKeyId).toMatch(/^HOPE[0-9A-F]{24}$/);
    expect(secretAccessKey.length).toBeGreaterThan(30);

    await secretDialog.getByRole('button', { name: 'Done' }).click();
    await expect(secretDialog).toBeHidden();

    const grid = page.getByRole('grid', { name: 'Storage access keys' });
    const row = grid.locator('[data-slot="data-grid-row"]').filter({ hasText: keyName });
    await expect(row).toBeVisible();
    await expect(row).toContainText(accessKeyId);

    await row.getByRole('button', { name: `Delete access key ${keyName}` }).click();
    const confirmDialog = page.getByRole('alertdialog', { name: 'Delete access key?' });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Delete key' }).click();

    await expect(page.getByText('Access key deleted')).toBeVisible();
    await expect(grid.locator('[data-slot="data-grid-row"]').filter({ hasText: keyName })).toBeHidden();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/tenants/storage');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});
