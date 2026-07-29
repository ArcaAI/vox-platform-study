/**
 * Frame 17.1 — Schedulers screen spec: shell + table render against the live
 * stack and the axe gate in both themes (rule 11 §11).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';
import type { SchedulerInfo } from '../../src/features/queues/api/types';

async function loadSchedulers(page: Page): Promise<SchedulerInfo[]> {
  return page.evaluate(async () => {
    const response = await fetch('/api/hope/admin/schedulers');
    if (!response.ok) throw new Error(`Could not load schedulers (${response.status})`);
    return (await response.json()) as SchedulerInfo[];
  });
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

async function openSchedulers(page: Page) {
  await page.goto('/schedulers');
  await expect(page.getByRole('heading', { level: 1, name: 'Schedulers' })).toBeVisible();
  await expect(page.getByLabel('Search')).toBeVisible();
  // Settle the table (skeletons mirror the layout, then give way to data).
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
}

test.describe('schedulers screen', () => {
  test('renders the table with no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSchedulers(page);
    await expectNoA11yViolations(page);
  });

  test('renders the table with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openSchedulers(page);
    await expectNoA11yViolations(page);
  });

  test('filters by type and by status', async ({ page }) => {
    await openSchedulers(page);
    const rows = page.getByRole('grid', { name: 'Schedulers' }).locator('[data-slot="data-grid-row"]');
    await expect(rows.first()).toBeVisible();

    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('option', { name: 'Cron' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);

    await page
      .getByRole('button', { name: /^Filters/ })
      .first()
      .click();
    await page.getByRole('option', { name: 'Running' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  });

  test('opens the edit-cron dialog for a current cron schedule and cancels', async ({ page }) => {
    await openSchedulers(page);
    const scheduler = (await loadSchedulers(page)).find(({ type, source }) => type === 'cron' && source === 'static');
    expect(scheduler).toBeDefined();
    const editButton = page
      .getByRole('grid', { name: 'Schedulers' })
      .locator('[data-slot="data-grid-row"]')
      .filter({ hasText: scheduler!.name })
      .getByRole('button', { name: `Edit cron for ${scheduler!.name}` });
    await expect(editButton).toBeVisible();
    await editButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /^Edit cron/ })).toBeVisible();
    await expect(dialog.getByLabel('Cron expression')).toHaveValue(scheduler!.cronExpression ?? '');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('edits and cancels a cron draft without saving', async ({ page }) => {
    await openSchedulers(page);
    const scheduler = (await loadSchedulers(page)).find(({ type, source }) => type === 'cron' && source === 'static');
    expect(scheduler).toBeDefined();
    const editButton = page
      .getByRole('grid', { name: 'Schedulers' })
      .locator('[data-slot="data-grid-row"]')
      .filter({ hasText: scheduler!.name })
      .getByRole('button', { name: `Edit cron for ${scheduler!.name}` });
    await editButton.click();
    const dialog = page.getByRole('dialog');
    const cronInput = dialog.getByLabel('Cron expression');
    const originalValue = await cronInput.inputValue();

    await cronInput.fill('0 4 * * *');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();

    await editButton.click();
    await expect(dialog.getByLabel('Cron expression')).toHaveValue(originalValue);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('disabling a schedule opens a confirm dialog that can be cancelled', async ({ page }) => {
    await openSchedulers(page);
    const runningToggles = page.getByRole('switch', { checked: true });
    await expect(runningToggles.first()).toBeVisible();

    await runningToggles.first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: /Disable scheduler/ })).toBeVisible();
    await expect(dialog.getByText('No runs are lost')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(runningToggles.first()).toBeChecked();
  });

  test('rejects disabling a static scheduler and keeps it running', async ({ page }) => {
    await openSchedulers(page);
    const scheduler = (await loadSchedulers(page)).find(({ type, source, running }) => type === 'cron' && source === 'static' && running);
    expect(scheduler).toBeDefined();
    const toggle = page.getByRole('switch', { name: `Toggle ${scheduler!.name}` });
    await expect(toggle).toBeChecked();

    await toggle.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: /Disable scheduler/ })).toBeVisible();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes(`/admin/schedulers/${encodeURIComponent(scheduler!.name)}/toggle`),
    );
    await dialog.getByRole('button', { name: 'Disable scheduler' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(400);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(toggle).toBeChecked();
  });
});
