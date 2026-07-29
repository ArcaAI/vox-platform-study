/**
 * Frame 35 — Transcription jobs against a RUNNING stack (rule 12 gate 3):
 * screen smoke plus axe scans in both themes. Skips with actionable messages
 * when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // The jobs surface is tenant-scoped: elevated sessions see the "Select a
  // working tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Transcription Jobs' })).toBeVisible();
  const emptyState = page.getByText(/No transcription jobs yet|No jobs in range/);
  const errorState = page.getByRole('alert').filter({ hasText: /Couldn.t load/ });
  const grid = page.getByRole('grid', { name: 'Transcription jobs' });
  const dataRows = grid.locator('[data-slot="data-grid-row"]');
  await expect(grid).toBeVisible();
  await expect(dataRows.first().or(emptyState.first()).or(errorState.first())).toBeVisible();
  await expect(errorState).toHaveCount(0);
}

async function expectStatusFilterInUrl(page: Page, status: string) {
  await expect
    .poll(() => {
      const encodedFilters = new URL(page.url()).searchParams.get('f');
      if (!encodedFilters) return false;
      try {
        const filters: unknown = JSON.parse(encodedFilters);
        return (
          Array.isArray(filters) &&
          filters.some(
            (filter) => Array.isArray(filter) && filter[0] === 'status' && filter[1] === 'eq' && filter[2] === 'select' && filter[3] === status,
          )
        );
      } catch {
        return false;
      }
    })
    .toBe(true);
}

test.describe('transcription jobs (frame 35)', () => {
  test('shows the header, stats strip, filters and the stream panel shell', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    const stats = page.getByRole('region', { name: 'Job status counts' });
    for (const label of ['Queued', 'Running', 'Completed', 'Failed']) {
      await expect(stats.getByText(label)).toBeVisible();
    }
    await expect(page.getByLabel('Search')).toBeVisible();
    await expect(page.getByText('Job stream')).toBeVisible();
    await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();
  });

  test('the failed stat card applies the FAILED status filter to the URL', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    await page.getByRole('button', { name: /filter the grid to failed jobs/i }).click();
    await expectStatusFilterInUrl(page, 'FAILED');
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('transcription jobs — filtering and search', () => {
  test('the Status facet filters the grid to a chosen status', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('option', { name: 'Done' }).click();
    await page.keyboard.press('Escape');
    await expectStatusFilterInUrl(page, 'COMPLETED');
    const grid = page.getByRole('grid', { name: 'Transcription jobs' });
    const rows = grid.locator('[data-slot="data-grid-row"]');
    const rowCount = await rows.count();
    for (let index = 0; index < rowCount; index += 1) {
      await expect(rows.nth(index).getByText('Done', { exact: true })).toBeVisible();
    }
  });

  test('the search box narrows the grid to matching job ids', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    const grid = page.getByRole('grid', { name: 'Transcription jobs' });
    const rows = grid.locator('[data-slot="data-grid-row"]');
    const rowCount = await rows.count();
    if (rowCount === 0) {
      await expect(page.getByText('No transcription jobs yet')).toBeVisible();
      return;
    }
    const fullJobId = (await rows.first().locator('[role="gridcell"]').first().innerText()).trim();
    const needle = fullJobId.slice(0, Math.max(6, Math.floor(fullJobId.length / 2)));
    await page.getByRole('textbox', { name: 'Search' }).fill(needle);
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(needle).replace(/%../g, '.')));
    const filteredRows = grid.locator('[data-slot="data-grid-row"]');
    const filteredCount = await filteredRows.count();
    for (let index = 0; index < filteredCount; index += 1) {
      await expect(filteredRows.nth(index).locator('[role="gridcell"]').first()).toContainText(needle, { ignoreCase: true });
    }
  });
  test('Clear filters returns the grid from the filtered-empty state', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    await page.getByRole('textbox', { name: 'Search' }).fill('does-not-exist-zzz');
    await expect(page.getByText('No jobs in range')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByText('No jobs in range')).toHaveCount(0);
    await expect(page).not.toHaveURL(/(?:^|[?&])f=/);
  });
  test('clicking a row opens the job detail and stream panel', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    const rows = page.getByRole('grid', { name: 'Transcription jobs' }).locator('[data-slot="data-grid-row"]');
    const rowCount = await rows.count();
    if (rowCount === 0) {
      await expect(page.getByText('No transcription jobs yet')).toBeVisible();
      await expect(page.getByText('Select a job in the grid to open its detail and live stream.')).toBeVisible();
      return;
    }
    const jobId = (await rows.first().locator('[role="gridcell"]').first().innerText()).trim();
    await rows.first().click();
    const panel = page.getByRole('region', { name: 'Live stream' }).locator('..');
    await expect(panel.getByText(jobId, { exact: false }).first()).toBeVisible();
    await expect(panel.getByText('Status', { exact: true })).toBeVisible();
    await expect(panel.getByText('Progress', { exact: true })).toBeVisible();
  });
});

test.describe('transcription jobs — row selection and stream panel', () => {
  test('a failed job selected in the grid shows its error message in the detail panel', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    await page.getByRole('button', { name: /filter the grid to failed jobs/i }).click();
    const rows = page.getByRole('grid', { name: 'Transcription jobs' }).locator('[data-slot="data-grid-row"]');
    const emptyState = page.getByText('No jobs in range', { exact: true });
    const errorState = page.getByRole('alert').filter({ hasText: /Couldn.t load/ });
    await expect(rows.first().or(emptyState).or(errorState).first()).toBeVisible();
    await expect(page.getByLabel('Loading data')).toHaveCount(0);
    await expect(errorState).toHaveCount(0);
    if ((await rows.count()) === 0) {
      await expect(emptyState).toBeVisible();
      return;
    }
    await rows.first().click();
    const panel = page.getByRole('region', { name: 'Live stream' }).locator('..');
    await expect(panel.getByText('Error', { exact: true })).toBeVisible();
  });

  test('the stream reconnect control stays hidden until a stream error is reachable', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    const rows = page.getByRole('grid', { name: 'Transcription jobs' }).locator('[data-slot="data-grid-row"]');
    const reconnect = page.getByRole('button', { name: 'Reconnect' });
    if ((await rows.count()) === 0) {
      await expect(page.getByText('No transcription jobs yet')).toBeVisible();
      await expect(reconnect).toHaveCount(0);
      return;
    }
    await rows.first().click();
    await expect(page.getByRole('region', { name: 'Live stream' })).toBeVisible();
    await expect(reconnect).toHaveCount(0);
  });
});

test.describe('transcription jobs — refresh and pagination', () => {
  test('the refresh button re-fetches without error', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    await page.getByRole('button', { name: /refresh/i }).click();
    await waitForSettled(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Transcription Jobs' })).toBeVisible();
  });

  test('walks to the next page when more than one page of jobs exists', async ({ page }) => {
    await page.goto('/audio/transcription-jobs');
    await waitForSettled(page);
    const nextButton = page.getByRole('button', { name: /^(Next page|Go to next page)$/ });
    if (!(await nextButton.isEnabled().catch(() => false))) {
      await expect(nextButton).toBeDisabled();
      await expect(page.getByText(/Page 1 of 1/)).toBeVisible();
      return;
    }
    const firstPageFirstRow = await page.getByRole('grid', { name: 'Transcription jobs' }).locator('[data-slot="data-grid-row"]').first().innerText();
    await nextButton.click();
    const secondPageFirstRow = await page
      .getByRole('grid', { name: 'Transcription jobs' })
      .locator('[data-slot="data-grid-row"]')
      .first()
      .innerText();
    expect(secondPageFirstRow).not.toBe(firstPageFirstRow);
  });
});
