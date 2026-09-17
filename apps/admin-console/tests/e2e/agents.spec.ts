/**
 * TASK-890 §3.10 — Agents (tier 30-49, `manage:Agent`) against a RUNNING stack: the fill-height
 * grid, the detail slide-over's tabs, the create wizard's Task → Model step over the tenant
 * catalogue (BYO providers first, then the single "Hope provider"), `?create=1` opening the
 * wizard directly (the Studio's create-agent deep link), and the publish confirm → integration
 * dialog. Skips with actionable messages when the app or gateway is down. Follows
 * `prompt-templates.spec.ts`'s shape.
 *
 * TASK-965 WS-4 — the grid is now the LINEAGE register: one row per slug, versions inside the
 * drawer. The two cases at the end of the "grid" block pin exactly that against the seed, since
 * it is the shape a unit test cannot prove: the register folds `realtime-transcription`'s v2
 * PUBLISHED/active and v1 DEPRECATED into ONE row (the owner's report), and the drawer's Versions
 * tab lists both.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // Agents are tenant-scoped: elevated sessions see the "Select a working tenant" gate first.
  await selectWorkingTenant(page);
});

const GRID_URL = '/agents';

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
  const emptyState = page.getByText('No agents yet');
  const dataRows = page.getByRole('grid', { name: 'Agents' }).locator('[data-slot="data-grid-row"]');
  await expect(
    dataRows
      .first()
      .or(emptyState.first())
      .or(page.getByRole('alert').filter({ hasText: /\S/ }).first())
      .first(),
  ).toBeVisible();
}

test.describe('agents — grid', () => {
  test('shows the header, New agent action and the fill-height grid', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await expect(page.getByRole('button', { name: 'New agent' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Agents' })).toBeVisible();
  });

  test('a row opens the console-wide lineage slide-over with the six tabs', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    const rows = page.getByRole('grid', { name: 'Agents' }).locator('[data-slot="data-grid-row"]');
    test.skip((await rows.count()) === 0, 'no agent rows to open — seed one first');
    await rows.first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    for (const tab of ['Overview', 'Versions', 'Draft', 'Assignments', 'Integration', 'Test run']) {
      await expect(drawer.getByRole('tab', { name: tab })).toBeVisible();
    }
  });

  test('a lineage with several versions is ONE row, not one row per version (TASK-965 WS-4)', async ({ page }) => {
    // The reported symptom, against the seed: `realtime-transcription` carries v2 PUBLISHED and
    // active over v1 DEPRECATED in the tenants that have branched it.
    await page.goto(`${GRID_URL}?search=realtime-transcription`);
    await waitForSettled(page);
    const slugCell = page.getByRole('grid', { name: 'Agents' }).getByText('realtime-transcription', { exact: true });
    test.skip((await slugCell.count()) === 0, 'this tenant has no realtime-transcription agent');
    await expect(slugCell).toHaveCount(1);
  });

  test('the lineage drawer’s Versions tab lists every version of the slug (TASK-965 WS-4)', async ({ page }) => {
    await page.goto(`${GRID_URL}?slug=realtime-transcription`);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await drawer.getByRole('tab', { name: 'Versions' }).click();
    const versions = drawer.getByRole('list', { name: /Versions of realtime-transcription/ });
    await expect(versions).toBeVisible();
    const rows = versions.getByRole('listitem');
    await expect(rows.first()).toBeVisible();
    // Exactly one version may be ACTIVE, and the drawer's caption names it.
    await expect(drawer.getByText(/runs the ACTIVE version|resolves to nothing/)).toBeVisible();
    test.skip((await rows.count()) < 2, 'this tenant has a single version of realtime-transcription');
    await expect(versions.getByText('v2', { exact: true })).toBeVisible();
    await expect(versions.getByText('v1', { exact: true })).toBeVisible();
  });

  test('?create=1 opens the create wizard directly (the Studio create-agent deep link)', async ({ page }) => {
    await page.goto(`${GRID_URL}?create=1`);
    // NOT `waitForSettled`: the wizard opens as a MODAL, and a modal marks the rest of the page
    // `aria-hidden`, so the grid behind it is unreachable by role for as long as it is open. The
    // wizard being visible is the whole assertion here anyway.
    await expect(page.getByRole('heading', { level: 2, name: 'New agent' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'New agent' })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('agents — create wizard (TASK-890 §3.7 model catalogue)', () => {
  test('the Model step lists a Provider then a Model over the tenant catalogue', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await page.getByRole('button', { name: 'New agent' }).click();
    const wizard = page.getByRole('dialog', { name: 'New agent' });
    await expect(wizard).toBeVisible();

    await wizard.getByRole('textbox', { name: /^Name/ }).fill(`E2E agent ${Date.now()}`);
    await wizard.getByRole('button', { name: 'Next' }).click();

    // Provider then Model — BYO connections first, then exactly one "Hope provider".
    // `exact` on both: the same step also renders "Fallback models (in order)", which a substring
    // match on "Model" resolves to as well (strict mode then fails on two elements).
    await expect(wizard.getByLabel('Provider', { exact: true })).toBeVisible();
    await expect(wizard.getByLabel('Model', { exact: true })).toBeVisible();
  });

  test('an unusable provider is shown greyed with its reason and a link to /ai-providers, never hidden', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await page.getByRole('button', { name: 'New agent' }).click();
    const wizard = page.getByRole('dialog', { name: 'New agent' });
    await wizard.getByRole('textbox', { name: /^Name/ }).fill(`E2E agent ${Date.now()}`);
    await wizard.getByRole('button', { name: 'Next' }).click();

    await wizard.getByLabel('Provider').click();
    const unusableOption = page.getByRole('option', { name: /—/ }).first();
    test.skip((await unusableOption.count()) === 0, 'every provider in this environment is usable today');
    await unusableOption.click();
    await expect(wizard.getByRole('link', { name: /Why can't I use this\?/ })).toBeVisible();
  });
});

test.describe('agents — draft test bench and publish (TASK-890 §3.8/§3.9)', () => {
  test('a DRAFT agent’s Test run tab defaults to a dry run and counts nothing until run live', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    // A seeded DRAFT row is a precondition this spec does not create itself — Studio/backend
    // seeds own that; skip cleanly when none exists rather than asserting a false negative.
    // TASK-965 WS-4 — the grid's "Open draft" column badges the lineage's one open draft.
    const draftBadge = page.getByRole('grid', { name: 'Agents' }).getByText('Draft', { exact: true }).first();
    test.skip((await draftBadge.count()) === 0, 'no seeded DRAFT agent — nothing to test against');
    await draftBadge.click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('tab', { name: 'Test run' }).click();
    await expect(drawer.getByLabel('Dry run')).toBeChecked();
    await expect(drawer.getByText(/nothing is billed/)).toBeVisible();
  });

  test('publishing opens the confirm dialog, then the integration view with the endpoint and vox-node snippet', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    const draftBadge = page.getByRole('grid', { name: 'Agents' }).getByText('Draft', { exact: true }).first();
    test.skip((await draftBadge.count()) === 0, 'no seeded DRAFT agent to publish');
    await draftBadge.click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: /^Publish$/ }).click();
    const confirmDialog = page.getByRole('dialog', { name: /Publish .+\?/ });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/POST \/agents\//)).toBeVisible();
    await expect(page.getByText(/hope\.agents\./)).toBeVisible();
    await expect(page.getByRole('link', { name: /Mint an API key/ })).toBeVisible();
  });
});
