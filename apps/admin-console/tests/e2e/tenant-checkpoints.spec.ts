/**
 * Tenant checkpoints screen spec: create a checkpoint, wait for READY, mint a
 * download URL, restore CONFIG_CONTENT through the break-glass dialog and see
 * the restore reach COMPLETED in the history tab; axe in both themes.
 * Requires a running stack (skips otherwise). Logs in as the seeded super
 * admin and picks a working tenant first, as every tier 30-49 screen needs.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { ADMIN_CREDENTIALS, API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  await selectWorkingTenant(page);
});

async function waitForListSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Checkpoints' })).toBeVisible();
  const grid = page.getByRole('grid', { name: 'Checkpoints' });
  const empty = page.getByText('Create your first checkpoint');
  await expect(grid.locator('[data-slot="data-grid-row"]').first().or(empty)).toBeVisible();
}

test.describe('tenant checkpoints screen', () => {
  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/checkpoints');
    await waitForListSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/checkpoints');
    await waitForListSettled(page);
    await expectNoA11yViolations(page);
  });

  test('create -> READY -> download URL -> restore CONFIG_CONTENT -> history shows COMPLETED', async ({ page }) => {
    test.setTimeout(180_000);
    const label = `e2e-${Date.now()}`;
    await page.goto('/checkpoints');
    await waitForListSettled(page);

    // Create (media off keeps the archive small and the run fast).
    await page.getByRole('button', { name: 'Create checkpoint' }).first().click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('Label *').fill(label);
    await sheet.getByRole('switch', { name: 'Include media' }).click();
    await sheet.getByRole('button', { name: 'Create checkpoint' }).click();

    const row = page.getByRole('grid', { name: 'Checkpoints' }).locator('[data-slot="data-grid-row"]', { hasText: label });
    await expect(row).toBeVisible();
    await expect(row.getByText('Ready')).toBeVisible({ timeout: 120_000 });

    // Download: the drawer mints a presigned URL (stubbed navigation target is not followed).
    await row.click();
    const drawer = page.getByRole('dialog');
    const downloadUrl = page.waitForResponse((response) => response.url().includes('/download-url') && response.status() === 200);
    await drawer.getByRole('button', { name: 'Download' }).click();
    const { url, filename } = (await (await downloadUrl).json()) as { url: string; filename: string };
    expect(url).toMatch(/^https?:\/\//);
    expect(filename).toMatch(/\.hcp$/);
    await page.goto('/checkpoints');
    await waitForListSettled(page);

    // Restore with break-glass.
    await page.getByRole('grid', { name: 'Checkpoints' }).locator('[data-slot="data-grid-row"]', { hasText: label }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Restore/ }).click();
    const restore = page.getByRole('dialog', { name: 'Restore checkpoint' });
    await restore.getByRole('checkbox', { name: /Configuration and content/ }).click();
    await restore.getByLabel(/Reason/).fill('e2e restore of the freshly created checkpoint');
    await restore.getByLabel('Your password').fill(ADMIN_CREDENTIALS.password);
    const nameInput = restore.getByLabel(/to confirm/);
    const tenantName = (await restore.locator('label[for]', { hasText: 'to confirm' }).locator('span').first().textContent()) ?? '';
    await nameInput.fill(tenantName);
    await restore.getByRole('button', { name: 'Restore checkpoint' }).click();

    // The screen hands over to the history tab; the restore ends COMPLETED.
    await expect(page.getByRole('grid', { name: 'Restore history' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Restore history' }).getByText(/^Completed/).first()).toBeVisible({ timeout: 150_000 });
  });
});
