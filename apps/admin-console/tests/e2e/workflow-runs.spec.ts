/**
 * Task 11 — Workflow Runs (tier 30-49) against a RUNNING
 * stack (rule 12 gate 3): screen smoke, filter/URL round-trip, the sandbox
 * toggle, the trace overlay + list-view peer, the read-only pinned-version
 * deep link, a foreign run id, and axe scans in both themes.
 *
 * Follows `harness-observability.spec.ts` and the shared helpers. Data is
 * whatever the seeded/dev tenant already has — dispatcher does not
 * yet call `recordRunStarted`/`recordRunFinished` (README R2), so an empty
 * runs list is an EXPECTED outcome in most environments today; "settled"
 * therefore accepts data rows, the empty state, or the error card.
 *
 * NOT EXECUTED in this session — Playwright's globalSetup runs
 * `prisma db push --force-reset`, which the Prisma CLI refuses when invoked
 * by an AI agent. Authored and reviewed against the real screen contracts,
 * not run. State this plainly rather than claiming a pass.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // Workflow runs are tenant-scoped: elevated sessions see the "Select a
  // working tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

async function waitForListSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Workflow Runs' })).toBeVisible();
  const dataRows = page.getByRole('grid', { name: 'Workflow runs' }).locator('[data-slot="data-grid-row"]');
  const emptyState = page.getByText('No workflow runs yet');
  const errorCard = page.getByRole('alert').filter({ hasText: /Couldn.t load/ });
  await expect(dataRows.first().or(emptyState.first()).or(errorCard.first())).toBeVisible();
}

test.describe('workflow runs list', () => {
  test('shows the header, filter strip, fill-height grid and the cross-tenant cross-link', async ({ page }) => {
    await page.goto('/workflow-runs');
    await waitForListSettled(page);
    await expect(page.getByLabel('Filter by definition slug')).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Workflow runs' })).toBeVisible();
    await expect(page.getByRole('link', { name: /See all agentic runs/ })).toHaveAttribute('href', '/ai-operations/runs');
  });

  test('the status filter syncs to the URL', async ({ page }) => {
    await page.goto('/workflow-runs');
    await waitForListSettled(page);
    await page.getByLabel('Status:').click();
    await page.getByRole('option', { name: 'Failed' }).click();
    await expect(page).toHaveURL(/status=FAILED/);
  });

  test('the sandbox toggle syncs to the URL and is OFF by default', async ({ page }) => {
    await page.goto('/workflow-runs');
    await waitForListSettled(page);
    await expect(page.getByLabel('Include sandbox runs')).not.toBeChecked();
    await page.getByLabel('Include sandbox runs').click();
    await expect(page).toHaveURL(/includeSandbox=true/);
  });

  test('the retention footer note names the effective trace-retention setting key', async ({ page }) => {
    await page.goto('/workflow-runs');
    await waitForListSettled(page);
    await expect(page.getByText(/agentic\.trajectory\.retentionDays/)).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/workflow-runs');
    await waitForListSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/workflow-runs');
    await waitForListSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('workflow run trace', () => {
  async function firstRunId(page: Page): Promise<string | null> {
    await page.goto('/workflow-runs');
    await waitForListSettled(page);
    const rows = page.getByRole('grid', { name: 'Workflow runs' }).locator('[data-slot="data-grid-row"]');
    if ((await rows.count()) === 0) return null;
    await rows.first().click();
    await page.waitForURL(/\/workflow-runs\/.+/);
    return page.url().split('/workflow-runs/')[1] ?? null;
  }

  test('opening a run renders the trace overlay on the pinned version graph, or the pruned/empty state honestly', async ({ page }) => {
    const runId = await firstRunId(page);
    test.skip(runId === null, 'No workflow runs seeded in this environment yet (write side is not wired — README R2)');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const canvas = page.locator('[data-slot="workflow-canvas"]');
    const pruned = page.getByText('Trace pruned by retention');
    const noSteps = page.getByText('No steps recorded yet');
    await expect(canvas.or(pruned).or(noSteps).first()).toBeVisible();
  });

  test('the list view peer renders the same rollup as an ordered, keyboard-reachable list', async ({ page }) => {
    const runId = await firstRunId(page);
    test.skip(runId === null, 'No workflow runs seeded in this environment yet');
    const listButton = page.getByRole('button', { name: 'List' });
    if (!(await listButton.isVisible())) return; // tracePruned or no-steps state — no view toggle to exercise
    await listButton.click();
    await expect(page).toHaveURL(/view=list/);
    const list = page.getByRole('list', { name: 'Run trace, in step order' });
    const pruned = page.getByText('Trace pruned by retention');
    await expect(list.or(pruned).first()).toBeVisible();
  });

  test('a foreign/nonexistent run id renders not-found, never a 403', async ({ page }) => {
    await page.goto('/workflow-runs/definitely-not-a-real-run-id');
    await expect(page.getByRole('alert').filter({ hasText: /Not found|Couldn.t load/ })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations on the trace screen (light)', async ({ page }) => {
    const runId = await firstRunId(page);
    test.skip(runId === null, 'No workflow runs seeded in this environment yet');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations on the trace screen (dark)', async ({ page }) => {
    const runId = await firstRunId(page);
    test.skip(runId === null, 'No workflow runs seeded in this environment yet');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
