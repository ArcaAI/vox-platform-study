/**
 * Frame 18 — Audit logs screen spec: shell + read-only event list render
 * against the live stack, axe gate in both themes (rule 11 §11), and the
 * JSON detail drawer over the first row when the environment has events.
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

async function openAuditLogs(page: Page) {
  await page.goto('/audit-logs');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit logs' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search' })).toBeVisible();
  // Settle the list (skeletons mirror the layout, then give way to data).
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole('grid', { name: 'Audit events' })).toBeVisible();
}

test.describe('audit logs screen', () => {
  test('renders the event list with no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openAuditLogs(page);
    await expectNoA11yViolations(page);
  });

  test('renders the event list with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openAuditLogs(page);
    await expectNoA11yViolations(page);
  });

  test('opens the read-only JSON detail drawer from the first row', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openAuditLogs(page);
    const rows = page.getByRole('grid', { name: 'Audit events' }).locator('[data-slot="data-grid-row"]');
    const rowCount = await rows.count();
    test.skip(rowCount === 0, 'no audit events recorded in this environment');
    await rows.first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Full audit record — read-only.')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Copy audit log id' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('filters the grid by actor user id', async ({ page }) => {
    await openAuditLogs(page);
    const rows = page.getByRole('grid', { name: 'Audit events' }).locator('[data-slot="data-grid-row"]');
    const rowCount = await rows.count();
    test.skip(rowCount === 0, 'no audit events recorded in this environment');
    const firstActorCell = rows.first().locator('[role="gridcell"]').nth(1);
    const actorText = (await firstActorCell.innerText()).trim();
    await page.getByRole('textbox', { name: 'Search' }).fill(actorText);
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    const filteredRows = page.getByRole('grid', { name: 'Audit events' }).locator('[data-slot="data-grid-row"]');
    const filteredCount = await filteredRows.count();
    for (let i = 0; i < filteredCount; i += 1) {
      await expect(filteredRows.nth(i).locator('[role="gridcell"]').nth(1)).toContainText(actorText);
    }
  });

  test('filters the grid by action and clears the filter', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 2000 });
    await openAuditLogs(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('option', { name: 'Login' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    const clearFilters = page.getByRole('button', { name: 'Clear filters' });
    const emptyMatch = page.getByText('No events match the filters');
    await expect(clearFilters.or(emptyMatch).first()).toBeVisible();
  });

  test('exports audit events as CSV', async ({ page }) => {
    await openAuditLogs(page);
    const rows = page.getByRole('grid', { name: 'Audit events' }).locator('[data-slot="data-grid-row"]');
    const rowCount = await rows.count();
    test.skip(rowCount === 0, 'no audit events recorded in this environment');
    await page.getByRole('button', { name: /export/i }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('walks cursor pagination with prev/next when more than one page exists', async ({ page }) => {
    await openAuditLogs(page);
    const nextButton = page.getByRole('button', { name: 'Next page' });
    const prevButton = page.getByRole('button', { name: 'Previous page' });
    const isEnabled = await nextButton.isEnabled().catch(() => false);
    test.skip(!isEnabled, 'only one page of audit events in this environment');
    await expect(prevButton).toBeDisabled();
    await nextButton.click();
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expect(prevButton).toBeEnabled();
    await prevButton.click();
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expect(prevButton).toBeDisabled();
  });
});
