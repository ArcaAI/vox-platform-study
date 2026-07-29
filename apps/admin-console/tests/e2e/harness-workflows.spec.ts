/**
 * Frame 38 — Harness workflows against a RUNNING stack (rule 12 gate 3):
 * screen smoke plus axe scans in both themes. Skips with actionable messages
 * when the app or gateway is down. The workflow list proxies to a
 * Temporal-backed service that may be down in local dev, so "settled" accepts
 * data rows, the empty state or the error card.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // Harness workflows are tenant-scoped: elevated sessions see the
  // "Select a working tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Harness Workflows' })).toBeVisible();
  // Data rows are focusable (row click -> detail); skeletons are not. When
  // Temporal is unreachable the grid renders the alert error card instead.
  const dataRows = page.getByRole('grid', { name: 'Harness workflows' }).locator('[data-slot="data-grid-row"]');
  const emptyState = page.getByText('No harness workflows');
  const errorCard = page.getByRole('alert').filter({ hasText: /Couldn.t load/ });
  await expect(dataRows.first().or(emptyState.first()).or(errorCard.first())).toBeVisible();
}

test.describe('harness workflows (frame 38)', () => {
  test('shows the header, filter strip and the fill-height grid', async ({ page }) => {
    // The Detail and Signals-&-lifecycle side panels moved into the
    // detail slide-over (opened by selecting a workflow); the grid is
    // now primary and polls live while runs are RUNNING.
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(page.getByLabel('Search workflow id')).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Harness workflows' })).toBeVisible();
  });

  test('the state filter syncs to the URL', async ({ page }) => {
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    await page.getByLabel('State:').click();
    await page.getByRole('option', { name: 'Running' }).click();
    await expect(page).toHaveURL(/state=RUNNING/);
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('harness workflows filters and detail (frame 38)', () => {
  test('selecting a row populates the detail drawer or preserves the empty state', async ({ page }) => {
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    const rows = page.getByRole('grid', { name: 'Harness workflows' }).locator('[data-slot="data-grid-row"]');
    if ((await rows.count()) === 0) {
      await expect(page.getByText('No harness workflows')).toBeVisible();
      return;
    }

    await rows.first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Copy workflow id' })).toBeVisible();
    await expect(drawer.getByText('Type')).toBeVisible();
    await expect(drawer.getByText('State')).toBeVisible();
  });

  test('the type filter narrows the grid or shows the filtered empty state', async ({ page }) => {
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    const rows = page.getByRole('grid', { name: 'Harness workflows' }).locator('[data-slot="data-grid-row"]');
    const initialCount = await rows.count();

    await page.getByLabel('Type:').click();
    await page.getByRole('option', { name: 'doc' }).click();
    await expect(page).toHaveURL(/type=doc/);

    const filteredCount = await rows.count();
    expect(filteredCount).toBeLessThanOrEqual(initialCount);
    if (initialCount === 0) {
      await expect(page.getByText('No workflows match the filter')).toBeVisible();
      return;
    }
    for (const cell of await rows.locator('[role="gridcell"]').filter({ hasText: /^doc$/ }).all()) {
      await expect(cell).toBeVisible();
    }
  });

  test('searching by workflow id filters the loaded page or shows the filtered empty state', async ({ page }) => {
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    const rows = page.getByRole('grid', { name: 'Harness workflows' }).locator('[data-slot="data-grid-row"]');
    const initialCount = await rows.count();
    const needle =
      initialCount === 0 ? 'zzz-no-such-workflow-zzz' : (await rows.first().locator('[role="gridcell"]').first().innerText()).slice(0, 8);

    await page.getByLabel('Search workflow id').fill(needle);
    await expect(page).toHaveURL(new RegExp(`search=${needle}`));

    const filteredRows = page.getByRole('grid', { name: 'Harness workflows' }).locator('[data-slot="data-grid-row"]');
    const count = await filteredRows.count();
    if (initialCount === 0) {
      expect(count).toBe(0);
      await expect(page.getByText('No workflows match the filter')).toBeVisible();
      return;
    }
    expect(count).toBeGreaterThan(0);
    for (const row of await filteredRows.all()) {
      await expect(row).toContainText(needle, { ignoreCase: true });
    }
  });

  test('clear filters resets the grid and its empty state', async ({ page }) => {
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    const rows = page.getByRole('grid', { name: 'Harness workflows' }).locator('[data-slot="data-grid-row"]');
    const initialCount = await rows.count();

    await page.getByLabel('Search workflow id').fill('no-such-workflow-id-zzz');
    await expect(page.getByText('No workflows match the filter')).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByText('No workflows match the filter')).toBeHidden();
    await expect(page.getByLabel('Search workflow id')).toHaveValue('');
    if (initialCount === 0) {
      await expect(page.getByText('No harness workflows')).toBeVisible();
      return;
    }
    await expect(rows.first()).toBeVisible();
  });

  test('terminate requires typing the exact workflow id before confirming, when workflows exist', async ({ page }) => {
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    const rows = page.getByRole('grid', { name: 'Harness workflows' }).locator('[data-slot="data-grid-row"]');
    if ((await rows.count()) === 0) {
      await expect(page.getByText('No harness workflows')).toBeVisible();
      return;
    }

    const workflowId = await rows.first().locator('[role="gridcell"]').first().innerText();
    await rows.first().click();
    await page.getByRole('button', { name: 'Terminate', exact: true }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Terminate workflow?' });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Terminate workflow' });
    await expect(confirm).toBeDisabled();

    await dialog.getByLabel(`Type ${workflowId} to confirm`).fill('definitely-the-wrong-id');
    await expect(confirm).toBeDisabled();

    await dialog.getByLabel(`Type ${workflowId} to confirm`).fill(workflowId);
    await expect(confirm).toBeEnabled();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('the live sessions card expands to read-only session stats or shows its empty state', async ({ page }) => {
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    const sessionsHeading = page.getByRole('heading', { level: 3, name: 'Live sessions' });
    await expect(sessionsHeading).toBeVisible();

    const card = sessionsHeading.locator('..');
    const sessionButtons = card.getByRole('list', { name: 'Active live-documentation sessions' }).getByRole('button');
    const count = await sessionButtons.count();
    if (count === 0) {
      await expect(card.getByText('No live-documentation sessions are streaming right now.')).toBeVisible();
      return;
    }

    const firstSession = sessionButtons.first();
    await expect(firstSession).toHaveAttribute('aria-expanded', 'false');
    await firstSession.click();
    await expect(firstSession).toHaveAttribute('aria-expanded', 'true');
    await expect(card.getByText('Flushes')).toBeVisible();
    await expect(card.getByText('SMR latency')).toBeVisible();
  });

  test('refresh reloads the grid without an error', async ({ page }) => {
    await page.goto('/harness/workflows');
    await waitForSettled(page);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await waitForSettled(page);
    await expect(page.getByRole('alert').filter({ hasText: /Couldn.t load/ })).toHaveCount(0);
  });
});
