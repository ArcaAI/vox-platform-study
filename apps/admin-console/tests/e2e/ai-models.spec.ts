/**
 * Frame 15 — AI Model Registry screen spec: authenticated smoke of the list
 * shell (h1 + registry region) and the rule 11 §11 axe gate in both themes.
 * Requires a running stack (skips otherwise, see helpers/stack.ts).
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
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
  await selectWorkingTenant(page);
});

test.describe('AI model registry screen', () => {
  test('renders the registry heading, filter bar and list region', async ({ page }) => {
    await page.goto('/ai-models');
    await expect(page.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeVisible();
    await expect(page.getByLabel('Search')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Register model' }).first()).toBeVisible();
    await expect(page.getByRole('grid', { name: 'AI models' })).toBeVisible();
  });

  test('registers a model, edits it, then deletes it', async ({ page }) => {
    const identifier = Date.now();
    const name = `000 E2E model ${identifier}`;
    const slug = `000-e2e-model-${identifier}`;
    await page.goto('/ai-models');
    await expect(page.getByRole('grid', { name: 'AI models' })).toBeVisible();
    const rowsPerPage = page.getByRole('combobox', { name: 'Rows per page' });
    await rowsPerPage.click();
    await page.getByRole('option', { name: '100', exact: true }).click();
    await expect(rowsPerPage).toHaveText('100');

    await page.getByRole('button', { name: 'Register model' }).first().click();
    const registerSheet = page.getByRole('dialog', { name: 'Register model' });
    await registerSheet.getByLabel(/^Name/).fill(name);
    await registerSheet.getByLabel(/^Slug/).fill(slug);
    await registerSheet.getByLabel(/^Task type/).fill('AUTOMATIC_SPEECH_RECOGNITION');
    await registerSheet.getByLabel(/^Source URI/).fill('openai/whisper-e2e-fixture');
    await registerSheet.getByRole('button', { name: 'Register model' }).click();
    await expect(registerSheet).toBeHidden();

    const row = page.getByRole('grid', { name: 'AI models' }).getByText(slug).first();
    await expect(row).toBeVisible();

    await page.getByRole('button', { name: `Edit ${name}` }).click();
    const editSheet = page.getByRole('dialog', { name: 'Edit model' });
    await editSheet.getByLabel('Compute type', { exact: true }).fill('float16');
    await editSheet.getByRole('button', { name: 'Save changes' }).click();
    await expect(editSheet).toBeHidden();

    await page.getByRole('button', { name: `Delete ${name}` }).click();
    const confirmDialog = page.getByRole('alertdialog', { name: 'Delete model' });
    await expect(confirmDialog.getByText(slug)).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Delete model' }).click();
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByRole('grid', { name: 'AI models' }).getByText(slug)).toHaveCount(0);
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

  test('the register form requires name, slug, task type and source URI', async ({ page }) => {
    await page.goto('/ai-models');
    await page.getByRole('button', { name: 'Register model' }).first().click();
    const registerSheet = page.getByRole('dialog', { name: 'Register model' });
    await registerSheet.getByRole('button', { name: 'Register model' }).click();
    await expect(registerSheet).toBeVisible();
    const nameInput = registerSheet.getByLabel(/^Name/);
    expect(await nameInput.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
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

  // F-037: the base screen scan above never opened the discovery drawer, so
  // it never caught the drawer's scrollable body region being unreachable
  // by keyboard (axe SERIOUS `scrollable-region-focusable`).
  test('discovery drawer has no WCAG 2.2 AA violations (drawer-open state)', async ({ page }) => {
    await page.goto('/ai-models');
    await page.getByRole('button', { name: 'Discover from servers' }).click();
    await expect(page.getByRole('dialog', { name: 'Discover models from servers' })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
