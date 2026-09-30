/**
 * Frame 15 — AI Model Registry screen spec (TASK-1023): the platform admin's management grid (one Register model
 * sheet, Download jobs, cancel), the tenant admin's READ-ONLY view of the same route, the omni search / sort
 * contracts, and the rule 11 §11 axe gate in both themes.
 * Requires a running stack (skips otherwise, see helpers/stack.ts).
 *
 * A platform admin is a SUPER_ADMIN with NO working tenant (`GET admin/ai-models/access` → canManage), so this
 * spec deliberately does not call selectWorkingTenant().
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { impersonateUser, loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

/**
 * The SERVER-side row count, read from the page header ("N models in the
 * platform catalogue"). Page-size independent, which is what makes the
 * narrowing assertions below real rather than "the visible page got shorter".
 * The number is extracted from the matched text rather than stripped out of it:
 * the meta slot can also carry a "N with no provider" badge.
 */
async function catalogueTotal(page: Page): Promise<number> {
  const text =
    (await page
      .getByText(/[\d,]+ models in the platform catalogue/)
      .first()
      .textContent()) ?? '';
  const match = text.match(/([\d,]+) models in the platform catalogue/);
  return Number((match?.[1] ?? '').replace(/,/g, ''));
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // The platform admin manages the registry only while acting as the platform (no working tenant).
  await page.evaluate(() => fetch('/api/auth/working-tenant', { method: 'DELETE' }));
});

test.describe('AI model registry screen', () => {
  test('renders the registry heading, filter bar and list region', async ({ page }) => {
    await page.goto('/ai-models');
    await expect(page.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeVisible();
    await expect(page.getByLabel('Search')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Register model' }).first()).toBeVisible();
    await expect(page.getByRole('grid', { name: 'AI models' })).toBeVisible();
  });

  test('registers from Hugging Face with a repository id only, then finds the download in the jobs drawer', async ({ page }) => {
    // A tiny public repo: the point is the flow, not the weights.
    const repoId = 'sshleifer/tiny-gpt2';
    await page.goto('/ai-models');
    await expect(page.getByRole('grid', { name: 'AI models' })).toBeVisible();

    await page.getByRole('button', { name: 'Register model' }).first().click();
    const registerSheet = page.getByRole('dialog', { name: 'Register model' });
    await expect(registerSheet.getByRole('tab', { name: 'Hugging Face', selected: true })).toBeVisible();
    // No hyperparameters, no identity fields — one input.
    await expect(registerSheet.getByLabel(/^Repository id/)).toBeVisible();
    await expect(registerSheet.getByLabel(/^Slug/)).toHaveCount(0);

    await registerSheet.getByLabel(/^Repository id/).fill(repoId);
    await expect(registerSheet.getByRole('group', { name: 'Model summary' })).toBeVisible();

    await registerSheet.getByRole('button', { name: 'Register and download' }).click();
    // The platform may need to be told which service serves a model it cannot classify.
    const servedBy = registerSheet.getByLabel(/^Served by/);
    if (await servedBy.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await servedBy.click();
      await page.getByRole('option', { name: 'text', exact: true }).click();
      await registerSheet.getByRole('button', { name: 'Register and download' }).click();
    }
    await expect(registerSheet).toBeHidden();

    await page.getByRole('button', { name: /^Download jobs/ }).click();
    const jobs = page.getByRole('dialog', { name: 'Download jobs' });
    await expect(jobs).toBeVisible();
    await expect(jobs.getByText(/tiny-gpt2/i).first()).toBeVisible();

    // Clean up after ourselves: cancel while it is still running (removing the registration too), else unregister.
    const cancel = jobs.getByRole('button', { name: /^Cancel download of /i }).first();
    if (await cancel.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cancel.click();
      const dialog = page.getByRole('dialog', { name: 'Cancel download' });
      await dialog.getByRole('checkbox', { name: /also remove the registration/i }).click();
      await dialog.getByRole('button', { name: 'Cancel download' }).click();
      await expect(dialog).toBeHidden();
    }
  });

  test('the MLflow tab says it is not available yet', async ({ page }) => {
    await page.goto('/ai-models');
    await page.getByRole('button', { name: 'Register model' }).first().click();
    const registerSheet = page.getByRole('dialog', { name: 'Register model' });
    await registerSheet.getByRole('tab', { name: 'MLflow' }).click();
    await expect(registerSheet.getByText(/not available yet/i).first()).toBeVisible();
    await expect(registerSheet.getByRole('button', { name: /^Register/ })).toHaveCount(0);
  });

  test('the Local path tab browses the model bucket', async ({ page }) => {
    await page.goto('/ai-models');
    await page.getByRole('button', { name: 'Register model' }).first().click();
    const registerSheet = page.getByRole('dialog', { name: 'Register model' });
    await registerSheet.getByRole('tab', { name: 'Local path' }).click();
    await expect(registerSheet.getByRole('navigation', { name: 'Object prefix' })).toBeVisible();
    await expect(registerSheet.getByRole('button', { name: 'hope-models' })).toBeVisible();
  });

  test('the Download jobs drawer opens from the header', async ({ page }) => {
    await page.goto('/ai-models');
    await page.getByRole('button', { name: /^Download jobs/ }).click();
    await expect(page.getByRole('dialog', { name: 'Download jobs' })).toBeVisible();
  });

  test('editing is slim: name, description and tags are editable, identity is read-only', async ({ page }) => {
    await page.goto('/ai-models');
    const grid = page.getByRole('grid', { name: 'AI models' });
    await expect(grid).toBeVisible();
    const edit = page.getByRole('button', { name: /^Edit / }).first();
    test.skip(!(await edit.isVisible().catch(() => false)), 'no registered model to edit');
    await edit.click();
    const editSheet = page.getByRole('dialog', { name: 'Edit model' });
    await expect(editSheet.getByLabel(/^Name/)).toBeVisible();
    await expect(editSheet.getByLabel(/^Tags/)).toBeVisible();
    await expect(editSheet.getByLabel(/^Slug/)).toHaveCount(0);
    await expect(editSheet.getByRole('group', { name: 'Identity and classification' })).toBeVisible();
    await expect(editSheet.getByRole('tab', { name: 'Serving' })).toBeVisible();
  });

  /**
   * TASK-983 R1/R4. The only search coverage this spec carried was "the search
   * box is visible", which is exactly why the gateway ignoring `search` /
   * `searchFields` / `filters` / `sort` on `GET admin/ai-models/list` went
   * unnoticed: the box worked, the URL updated, and the server answered the
   * same unfiltered page every time.
   *
   * Both halves matter. The negative half fails loudly against the old
   * behaviour (a term no slug contains returned every row instead of the
   * filtered empty state); the positive half proves the narrowed set still
   * contains what was asked for, so "narrows" can never be satisfied by an
   * endpoint that simply returns nothing.
   */
  test('the omni search narrows the server result set (negative and positive)', async ({ page }) => {
    await page.goto('/ai-models');
    const grid = page.getByRole('grid', { name: 'AI models' });
    await expect(grid).toBeVisible();
    const dataRows = grid.locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first()).toBeVisible();
    const unfilteredTotal = await catalogueTotal(page);
    const slug = (await dataRows.first().locator('span.font-mono').first().textContent())?.trim();
    test.skip(!slug, 'no registered model to derive a slug from');

    // --- negative: a term no name or slug contains empties the grid ---------
    const missSearch = page.waitForResponse(
      (response) => response.url().includes('/admin/ai-models/list') && response.url().includes('search=') && response.ok(),
    );
    await page.getByLabel('Search').fill('zzzz-no-such-model');
    await expect(page).toHaveURL(/search=zzzz-no-such-model/);
    await missSearch;
    await expect(page.getByText('No models match your filters')).toBeVisible();
    await expect(dataRows).toHaveCount(0);
    expect(await catalogueTotal(page)).toBe(0);

    // --- positive: the row that WAS there is the row that comes back --------
    await page.getByLabel('Search').fill(slug!);
    await expect(page).toHaveURL(new RegExp(`search=${slug!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(grid.getByText(slug!, { exact: true }).first()).toBeVisible();
    const hitTotal = await catalogueTotal(page);
    expect(hitTotal).toBeGreaterThan(0);
    // A slug is unique, so a catalogue with more than one row MUST shrink.
    if (unfilteredTotal > 1) expect(hitTotal).toBeLessThan(unfilteredTotal);
  });

  /**
   * TASK-983 R1/R4 — the sort half of the same defect: `AiModelService.list`
   * hardcoded `sort: [{ name: 'asc' }]`, so `sort=name:desc` answered the
   * ascending page.
   *
   * Asserted on the RESPONSE PAYLOAD, not on the rendered row order, and that
   * is deliberate: `AiModelsScreen` re-orders the page it receives by Hugging
   * Face pipeline tag (`orderByPipelineTag`), so the top rendered row is the
   * same either way once the whole catalogue fits on one page. The server sort
   * decides WHICH rows a page contains, which is what the console's paging
   * depends on and what this pins.
   */
  test('sorting by name descending reverses the page the gateway returns', async ({ page }) => {
    await page.goto('/ai-models');
    const grid = page.getByRole('grid', { name: 'AI models' });
    await expect(grid).toBeVisible();

    // One page for the whole catalogue, so ascending and descending are the
    // same SET and the comparison is exact rather than "something moved".
    const wholeCatalogue = page.waitForResponse(
      (response) => response.url().includes('/admin/ai-models/list') && response.url().includes('limit=100') && response.ok(),
    );
    const rowsPerPage = page.getByRole('combobox', { name: 'Rows per page' });
    await rowsPerPage.click();
    await page.getByRole('option', { name: '100', exact: true }).click();
    await expect(rowsPerPage).toHaveText('100');
    const ascending = (((await (await wholeCatalogue).json()) as { data?: { name: string }[] }).data ?? []).map((model) => model.name);
    test.skip(ascending.length < 2, 'need at least two registered models to prove an ordering');

    const sorted = page.waitForResponse(
      (response) =>
        response.url().includes('/admin/ai-models/list') && decodeURIComponent(response.url()).includes('sort=name:desc') && response.ok(),
    );
    // The header IS the sort control: a dropdown trigger named "<label> column
    // options" holding Asc/Desc as checkbox items.
    await page.getByRole('button', { name: 'Model column options' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Desc' }).click();
    const descending = (((await (await sorted).json()) as { data?: { name: string }[] }).data ?? []).map((model) => model.name);

    expect(descending).toEqual([...ascending].reverse());
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/ai-models');
    await expect(page.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'AI models' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/ai-models');
    await expect(page.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'AI models' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the Register model sheet and the Download jobs drawer have no WCAG 2.2 AA violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/ai-models');
      await page.getByRole('button', { name: 'Register model' }).first().click();
      await expect(page.getByRole('dialog', { name: 'Register model' })).toBeVisible();
      await expectNoA11yViolations(page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Download jobs/ }).click();
      await expect(page.getByRole('dialog', { name: 'Download jobs' })).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }

  // F-037: the base screen scan above never opened the discovery drawer, so
  // it never caught the drawer's scrollable body region being unreachable
  // by keyboard (axe SERIOUS `scrollable-region-focusable`).
  test('discovery drawer has no WCAG 2.2 AA violations (drawer-open state)', async ({ page }) => {
    await page.goto('/ai-models');
    await page.getByRole('button', { name: 'Loaded on engines' }).click();
    await expect(page.getByRole('dialog', { name: 'Loaded on engines (read-only)' })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

test.describe('AI model registry — tenant admin (read-only)', () => {
  test.beforeEach(async ({ page }) => {
    await impersonateUser(page, 'arcaai_admin');
  });

  test('sees the registry read-only: no register, jobs, inventory or row actions', async ({ page }) => {
    await page.goto('/ai-models');
    await expect(page.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeVisible();
    await expect(page.getByRole('grid', { name: 'AI models' })).toBeVisible();
    for (const name of [/^Register model/, /^Download jobs/, /^Run inventory/, /^Download missing/, /^Loaded on engines/]) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Unregister / })).toHaveCount(0);
    // No bucket path leaks into a tenant view.
    await expect(page.getByText('/mnt/models-bucket')).toHaveCount(0);
  });

  test('has the AI models entry in the navigation', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: 'AI models' }).first()).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the read-only grid has no WCAG 2.2 AA violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/ai-models');
      await expect(page.getByRole('grid', { name: 'AI models' })).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }
});
