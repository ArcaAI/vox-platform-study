/**
 * Frame 40 — Consultations against a RUNNING stack (rule 12 gate 3), covering
 * BOTH scope branches of the matrix row 33 exception:
 *   1. elevated session, NO working tenant -> cross-tenant aggregate view
 *      (not a gate; no rows table)
 *   2. working tenant selected -> full screen (filters, grid, pagination)
 * plus axe scans (light + dark on the full view, one pass on the aggregate
 * view). Skips with actionable messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

/** The aggregate settles into the chart visual (zero-filled buckets always draw). */
async function waitForAggregateSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Consultations' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'New vs revisit consultations' })).toBeVisible();
}

test.describe('consultations aggregate exception (frame 40, row 33)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    // Deliberately NO selectWorkingTenant: the elevated session must see
    // the cross-tenant aggregate view INSTEAD of a working-tenant gate.
    await loginAsAdmin(page);
  });

  test('renders the cross-tenant aggregate view instead of a gate, without a rows grid', async ({ page }) => {
    await page.goto('/consultations');
    await waitForAggregateSettled(page);
    await expect(page.getByText('New vs revisit', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('select a working tenant to browse consultation rows', { exact: false })).toBeVisible();
    // Not the tier 30-49 gate...
    await expect(page.getByText('Select a working tenant', { exact: true })).toHaveCount(0);
    // ...and row data stays tenant-scoped: no consultations grid at all
    // (exact name — the aggregate chart carries its own sr-only data table
    // named "New vs revisit consultations").
    await expect(page.getByRole('grid', { name: 'Consultations', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (aggregate-only view)', async ({ page }) => {
    await page.goto('/consultations');
    await waitForAggregateSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('consultations (frame 40)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    await selectWorkingTenant(page);
  });

  async function waitForSettled(page: Page) {
    await waitForAggregateSettled(page);
    const emptyState = page.getByText('No consultations yet');
    // Data rows are focusable (row click -> read-only detail); skeleton rows
    // are not. Exact table name: the chart's sr-only table also contains
    // "Consultations".
    const dataRows = page.getByRole('grid', { name: 'Consultations', exact: true }).locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
  }

  test('shows the header, filter strip, aggregate card and the consultations grid', async ({ page }) => {
    await page.goto('/consultations');
    await waitForSettled(page);
    await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Consultations', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
  });

  test('the status filter syncs the URL', async ({ page }) => {
    await page.goto('/consultations');
    await waitForSettled(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('option', { name: 'Signed' }).click();
    await expect(page).toHaveURL(/status.*SIGNED/);
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/consultations');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/consultations');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('consultations filters, detail and chart interactions (frame 40)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    await selectWorkingTenant(page);
  });

  async function waitForSettled(page: Page) {
    await waitForAggregateSettled(page);
    const emptyState = page.getByText('No consultations yet');
    const dataRows = page.getByRole('grid', { name: 'Consultations', exact: true }).locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
  }

  test('the doctor filter syncs the URL and narrows the grid', async ({ page }) => {
    await page.goto('/consultations');
    await waitForSettled(page);
    const grid = page.getByRole('grid', { name: 'Consultations', exact: true });
    const rowCountBefore = await grid.locator('[data-slot="data-grid-row"]').count();

    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('textbox', { name: 'Doctor value' }).fill('doctor-does-not-exist');
    await expect(page).toHaveURL(/doctorId/);

    const emptyState = page.getByText('No consultations in range');
    const dataRows = grid.locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
    const rowCountAfter = await dataRows.count();
    expect(rowCountAfter <= rowCountBefore).toBe(true);
  });

  test('the department filter syncs the URL and narrows the grid', async ({ page }) => {
    await page.goto('/consultations');
    await waitForSettled(page);
    const grid = page.getByRole('grid', { name: 'Consultations', exact: true });
    const rowCountBefore = await grid.locator('[data-slot="data-grid-row"]').count();

    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('textbox', { name: 'Department value' }).fill('department-does-not-exist');
    await expect(page).toHaveURL(/departmentId/);

    const emptyState = page.getByText('No consultations in range');
    const dataRows = grid.locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
    const rowCountAfter = await dataRows.count();
    expect(rowCountAfter <= rowCountBefore).toBe(true);
  });

  test('the type filter narrows the visible rows client-side', async ({ page }) => {
    await page.goto('/consultations');
    await waitForSettled(page);
    const grid = page.getByRole('grid', { name: 'Consultations', exact: true });
    const dataRows = grid.locator('[data-slot="data-grid-row"]');
    const rowCountBefore = await dataRows.count();
    test.skip(rowCountBefore === 0, 'no seeded consultations to narrow');

    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('option', { name: 'New' }).click();
    await expect(page).toHaveURL(/type.*new/);
    await page.keyboard.press('Escape');

    const emptyState = page.getByText('No consultations in range');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
    const rowCountAfter = await dataRows.count();
    expect(rowCountAfter <= rowCountBefore).toBe(true);
    for (const badge of await grid
      .locator('[data-slot="data-grid-row"]')
      .getByText(/^(New|Revisit)$/)
      .allTextContents()) {
      expect(badge).toBe('New');
    }
  });

  test('clear filters resets to the unfiltered grid', async ({ page }) => {
    await page.goto('/consultations');
    await waitForSettled(page);

    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('textbox', { name: 'Doctor value' }).fill('doctor-does-not-exist');
    await expect(page.getByText('No consultations in range')).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/doctorId/);
    await page.keyboard.press('Escape');
    const emptyState = page.getByText('No consultations yet');
    const dataRows = page.getByRole('grid', { name: 'Consultations', exact: true }).locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
  });

  test('clicking a row opens the detail panel with masked patient id and core fields', async ({ page }) => {
    await page.goto('/consultations');
    await waitForSettled(page);
    const dataRows = page.getByRole('grid', { name: 'Consultations', exact: true }).locator('[data-slot="data-grid-row"]');
    test.skip((await dataRows.count()) === 0, 'no seeded consultations to open');

    await dataRows.first().click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('(masked)')).toBeVisible();
    await expect(panel.getByText('Doctor', { exact: true })).toBeVisible();
    await expect(panel.getByText('Department', { exact: true })).toBeVisible();
    await expect(panel.getByText('Status', { exact: true })).toBeVisible();
    await expect(panel.getByText('Type', { exact: true })).toBeVisible();
    await expect(panel.getByText('Read-only', { exact: false }).first()).toBeVisible();
  });

  test('the aggregate granularity toggle flips aria-pressed between Day and Month', async ({ page }) => {
    await page.goto('/consultations');
    await waitForSettled(page);
    const group = page.getByRole('group', { name: 'Aggregate granularity' });
    const day = group.getByRole('button', { name: 'Day' });
    const month = group.getByRole('button', { name: 'Month' });

    await expect(day).toHaveAttribute('aria-pressed', 'false');
    await expect(month).toHaveAttribute('aria-pressed', 'false');

    await day.click();
    await expect(day).toHaveAttribute('aria-pressed', 'true');
    await expect(month).toHaveAttribute('aria-pressed', 'false');

    await month.click();
    await expect(day).toHaveAttribute('aria-pressed', 'false');
    await expect(month).toHaveAttribute('aria-pressed', 'true');
  });
});
