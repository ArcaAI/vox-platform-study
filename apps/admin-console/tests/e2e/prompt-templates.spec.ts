/**
 * Prompt Instruction Templates against a RUNNING stack (rule 12
 * gate 3): the Fallbacks resolution map, the template grid + detail
 * slide-over, create/delete, filters, and axe scans in both themes. Skips with
 * actionable messages when the app or gateway is down.
 *
 * Moved from `agents.spec.ts` with the screen. That file had also drifted:
 * it still asserted the level-1 heading "Agents & Prompt Templates", renamed
 * to "Agent Catalog", so all 11 of its cases were failing before
 * this change.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // Prompt templates are tenant-scoped: elevated sessions see the
  // "Select a working tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

/** The grid lives on the Templates tab; Fallbacks is the landing tab. */
const GRID_URL = '/prompt-templates?tab=templates';

/** One filter's block inside the Filters panel — label span plus its control. */
function filterBlock(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator('..');
}

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Prompt Instruction Templates' })).toBeVisible();
  const emptyState = page.getByText('No prompt templates yet');
  // Data rows are focusable (row click -> selection); skeleton rows are not.
  const dataRows = page.getByRole('grid', { name: 'Prompt templates' }).locator('[data-slot="data-grid-row"]');
  await expect(
    dataRows
      .first()
      .or(emptyState.first())
      .or(page.getByRole('alert').filter({ hasText: /\S/ }).first())
      .first(),
  ).toBeVisible();
}

test.describe('prompt templates — grid', () => {
  test('shows the header, New action and the fill-height grid', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await expect(page.getByRole('button', { name: 'New template' }).first()).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Prompt templates' })).toBeVisible();
  });

  test('a row opens the console-wide detail slide-over', async ({ page }) => {
    // The former side panels are now a DetailDrawer with Overview /
    // Versions / Test-run tabs.
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await page.getByRole('grid', { name: 'Prompt templates' }).locator('[data-slot="data-grid-row"]').first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('tab', { name: 'Versions' })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('prompt templates — create/delete', () => {
  test('creates a template then deletes it via the drawer footer action and type-to-confirm', async ({ page }) => {
    const name = `E2E Template ${Date.now()}`;
    await page.goto(GRID_URL);
    await waitForSettled(page);

    await page.getByRole('button', { name: 'New template' }).first().click();
    const createDrawer = page.getByRole('dialog', { name: 'New prompt template' });
    await createDrawer.getByRole('textbox', { name: /^Name/ }).fill(name);
    await createDrawer.getByRole('textbox', { name: /^Prompt content/ }).fill('You are a clinical scribe. Summarize {{transcript}}.');
    await createDrawer.getByRole('button', { name: 'Create template' }).click();
    await expect(createDrawer).toBeHidden();

    const detailDrawer = page.getByRole('dialog', { name });
    await expect(detailDrawer).toBeVisible();
    await detailDrawer.getByRole('button', { name: 'Delete' }).click();
    const confirmDialog = page.getByRole('alertdialog', { name: 'Delete template?' });
    await expect(confirmDialog).toBeVisible();
    const confirmButton = confirmDialog.getByRole('button', { name: 'Delete template' });
    await expect(confirmButton).toBeDisabled();
    await confirmDialog.getByLabel(`Type ${name} to confirm`).fill(name);
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(confirmDialog).toBeHidden();
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await page.getByLabel('Search').fill(name);
    await expect(page.getByText('No templates match your filters')).toBeVisible();
  });

  test('the create dialog gates submit on required name and content', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);

    await page.getByRole('button', { name: 'New template' }).first().click();
    const createDialog = page.getByRole('dialog', { name: 'New prompt template' });
    const submit = createDialog.getByRole('button', { name: 'Create template' });
    await expect(submit).toBeDisabled();

    await createDialog.getByRole('textbox', { name: /^Name/ }).fill('Validation Only');
    await expect(submit).toBeDisabled();

    await createDialog.getByRole('textbox', { name: /^Prompt content/ }).fill('Some content');
    await expect(submit).toBeEnabled();

    await createDialog.getByRole('textbox', { name: /^Name/ }).fill('');
    await expect(submit).toBeDisabled();
  });

  test('the delete confirm dialog gates on typing the exact template name', async ({ page }) => {
    const name = `E2E Gate ${Date.now()}`;
    await page.goto(GRID_URL);
    await waitForSettled(page);

    await page.getByRole('button', { name: 'New template' }).first().click();
    const createDrawer = page.getByRole('dialog', { name: 'New prompt template' });
    await createDrawer.getByRole('textbox', { name: /^Name/ }).fill(name);
    await createDrawer.getByRole('textbox', { name: /^Prompt content/ }).fill('Some content for the gate test.');
    await createDrawer.getByRole('button', { name: 'Create template' }).click();
    await expect(createDrawer).toBeHidden();

    const detailDrawer = page.getByRole('dialog', { name });
    await expect(detailDrawer).toBeVisible();
    await detailDrawer.getByRole('button', { name: 'Delete' }).click();
    const confirmDialog = page.getByRole('alertdialog', { name: 'Delete template?' });
    const confirmButton = confirmDialog.getByRole('button', { name: 'Delete template' });
    const typeToConfirm = confirmDialog.getByLabel(`Type ${name} to confirm`);

    await expect(confirmButton).toBeDisabled();
    await typeToConfirm.fill('wrong-name');
    await expect(confirmButton).toBeDisabled();
    await typeToConfirm.fill(name);
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(confirmDialog).toBeHidden();
  });
});

test.describe('prompt templates — selection and filters', () => {
  test('selecting a row populates the Versions panel', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);

    const dataRows = page.getByRole('grid', { name: 'Prompt templates' }).locator('[data-slot="data-grid-row"]');
    const emptyState = page.getByText('No prompt templates yet');
    await expect(dataRows.first()).toBeVisible();
    const firstRow = dataRows.first();
    const templateName = (await firstRow.textContent()) ?? '';
    await firstRow.click();
    const detailDrawer = page.getByRole('dialog');
    await expect(detailDrawer).toBeVisible();
    await detailDrawer.getByRole('tab', { name: 'Versions' }).click();
    await expect(
      detailDrawer
        .getByRole('list', { name: /Versions of / })
        .or(detailDrawer.getByText('No versions recorded yet.'))
        .first(),
    ).toBeVisible();
    expect(templateName.length).toBeGreaterThan(0);
  });

  test('the search filter narrows the grid', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await page.getByLabel('Search').fill('no-such-template-xyz-000');
    await expect(page.getByText('No templates match your filters')).toBeVisible();
    await expect(page.getByRole('grid', { name: 'Prompt templates' }).getByRole('button', { name: 'Clear filters' })).toBeVisible();
  });

  test('the department filter syncs to the URL', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    // Scope every lookup to the Dept filter's own block. The panel renders one
    // combobox + listbox PER filter, so a bare `.first()` silently targets
    // whichever filter column happens to come first — it used to be Dept, and
    // adding the Scope column ahead of it made that assumption drive the wrong
    // control.
    const deptFilter = filterBlock(page, 'Dept');
    await deptFilter.getByRole('combobox').click();
    const firstOption = deptFilter.getByRole('listbox', { name: 'Suggestions' }).getByRole('option').first();
    await expect(firstOption).toBeVisible();
    const label = await firstOption.textContent();
    await firstOption.click();
    await expect(page).toHaveURL(/departmentId/);
    expect(label?.length ?? 0).toBeGreaterThan(0);
  });

  // The scope discriminator decides whether a template is even a candidate for
  // tenant-wide resolution, so it is filterable alongside department and type.
  test('the scope filter syncs to the URL', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    const scopeFilter = filterBlock(page, 'Scope');
    await scopeFilter.getByRole('combobox').click();
    const option = scopeFilter.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: 'Tenant default' });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page).toHaveURL(/TENANT_DEFAULT/);
  });

  test('shows the empty state with a clear-filters action when a filter yields no rows', async ({ page }) => {
    await page.goto(GRID_URL);
    await waitForSettled(page);
    await page.getByLabel('Search').fill('no-such-template-xyz-000');
    await expect(page.getByText('No templates match your filters')).toBeVisible();
    const clearFilters = page.getByRole('grid', { name: 'Prompt templates' }).getByRole('button', { name: 'Clear filters' });
    await expect(clearFilters).toBeVisible();
    await clearFilters.click();
    await expect(page).not.toHaveURL(/search=/);
    await expect(page.getByText('No templates match your filters')).toBeHidden();
  });
});

/**
 * The Fallbacks tab is the reason this screen exists: it has to make visible
 * that pre-summary is tenant-wide (no department, no visit-type axis) while
 * summary is a department x visit-type matrix.
 */
test.describe('prompt templates — fallbacks map', () => {
  async function waitForFallbacks(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Prompt Instruction Templates' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Pre-summary/ })).toBeVisible();
  }

  test('lands on Fallbacks and states the pre-summary vs summary axes', async ({ page }) => {
    await page.goto('/prompt-templates');
    await waitForFallbacks(page);

    await expect(page.getByRole('tab', { name: 'Fallbacks', selected: true })).toBeVisible();
    // Pre-summary: one per tenant, no axes.
    await expect(page.getByText('no department axis')).toBeVisible();
    await expect(page.getByText('no visit-type axis')).toBeVisible();
    // Summary: two axes, rendered as a matrix with the visit types as columns.
    await expect(page.getByRole('heading', { level: 2, name: /Summary/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Summary — New referral/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Summary — Re-visit/ })).toBeVisible();
  });

  test('opens the assign-slot dialog from a matrix cell', async ({ page }) => {
    await page.goto('/prompt-templates');
    await waitForFallbacks(page);

    const change = page.getByRole('button', { name: /^Change New referral template for / }).first();
    await expect(change).toBeVisible();
    await change.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Template')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/prompt-templates');
    await waitForFallbacks(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/prompt-templates');
    await waitForFallbacks(page);
    await expectNoA11yViolations(page);
  });
});
