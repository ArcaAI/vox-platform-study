/**
 * Frame 32 — Agents & Prompt Templates against a RUNNING stack (rule 12
 * gate 3): screen smoke plus axe scans in both themes. Skips with actionable
 * messages when the app or gateway is down.
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

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Agents & Prompt Templates' })).toBeVisible();
    const emptyState = page.getByText('No prompt templates yet');
    // Data rows are focusable (row click -> selection); skeleton rows are not.
    const dataRows = page.getByRole('grid', { name: 'Prompt templates' }).locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first()).or(page.getByRole('alert').filter({ hasText: /\S/ }).first()).first()).toBeVisible();
}

test.describe('agents & prompt templates (frame 32)', () => {
    test('shows the header, New action and the fill-height grid', async ({ page }) => {
        await page.goto('/agents');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'New template' }).first()).toBeVisible();
        await expect(page.getByRole('grid', { name: 'Prompt templates' })).toBeVisible();
    });

    test('a row opens the console-wide detail slide-over', async ({ page }) => {
        // The former side panels are now a DetailDrawer with Overview /
        // Versions / Test-run tabs.
        await page.goto('/agents');
        await waitForSettled(page);
        await page.getByRole('grid', { name: 'Prompt templates' }).locator('[data-slot="data-grid-row"]').first().click();
        const drawer = page.getByRole('dialog');
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('tab', { name: 'Versions' })).toBeVisible();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/agents');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/agents');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});

test.describe('agents & prompt templates — create/delete (frame 32)', () => {
    test('creates a template then deletes it via the drawer footer action and type-to-confirm', async ({ page }) => {
        const name = `E2E Template ${Date.now()}`;
        await page.goto('/agents');
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
        await page.goto('/agents');
        await waitForSettled(page);
        await page.getByLabel('Search').fill(name);
        await expect(page.getByText('No templates match your filters')).toBeVisible();
    });

    test('the create dialog gates submit on required name and content', async ({ page }) => {
        await page.goto('/agents');
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
        await page.goto('/agents');
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

test.describe('agents & prompt templates — selection and filters (frame 32)', () => {
    test('selecting a row populates the Versions panel', async ({ page }) => {
        await page.goto('/agents');
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
            detailDrawer.getByRole('list', { name: /Versions of / }).or(detailDrawer.getByText('No versions recorded yet.')).first(),
        ).toBeVisible();
        expect(templateName.length).toBeGreaterThan(0);
    });

    test('the search filter narrows the grid', async ({ page }) => {
        await page.goto('/agents');
        await waitForSettled(page);
        await page.getByLabel('Search').fill('no-such-template-xyz-000');
        await expect(page.getByText('No templates match your filters')).toBeVisible();
        await expect(page.getByRole('grid', { name: 'Prompt templates' }).getByRole('button', { name: 'Clear filters' })).toBeVisible();
    });

    test('the department filter syncs to the URL', async ({ page }) => {
        await page.goto('/agents');
        await waitForSettled(page);
        await page.getByRole('button', { name: 'Filters' }).click();
        const deptCombobox = page.getByText('Dept').locator('..').getByRole('combobox');
        await deptCombobox.click();
        const firstOption = page.getByRole('listbox', { name: 'Suggestions' }).first().getByRole('option').first();
        await expect(firstOption).toBeVisible();
        const label = await firstOption.textContent();
        await firstOption.click();
        await expect(page).toHaveURL(/departmentId/);
        expect(label?.length ?? 0).toBeGreaterThan(0);
    });

    test('shows the empty state with a clear-filters action when a filter yields no rows', async ({ page }) => {
        await page.goto('/agents');
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
