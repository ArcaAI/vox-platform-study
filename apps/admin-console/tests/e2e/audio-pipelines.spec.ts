/**
 * Frame 34 — Audio pipelines against a RUNNING stack (rule 12 gate 3): screen
 * smoke plus axe scans in both themes. Skips with actionable messages when the
 * app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    await loginAsAdmin(page);
    // Pipelines are tenant-scoped: elevated sessions see the "Select a
    // working tenant" gate until one is chosen.
    await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
    await expect(page.getByRole('heading', { level: 1, name: 'Audio Pipelines' })).toBeVisible();
    const emptyState = page.getByText('No pipelines for this tenant');
    // Data rows are focusable (row click -> selection); skeleton rows are not.
    const dataRows = page.getByRole('grid', { name: 'Audio pipelines' }).locator('[data-slot="data-grid-row"]');
    await expect(dataRows.first().or(emptyState.first())).toBeVisible();
}

test.describe('audio pipelines (frame 34)', () => {
    test('shows the header, filters and the fill-height grid', async ({ page }) => {
        // Redesign (TASK-441): the former Config / Versions-&-lifecycle side
        // panels moved into the detail slide-over; the grid is now primary.
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await expect(page.getByRole('button', { name: 'New pipeline' }).first()).toBeVisible();
        await expect(page.getByLabel('Search')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
        const dataRows = page.getByRole('grid', { name: 'Audio pipelines' }).locator('[data-slot="data-grid-row"]');
        if ((await dataRows.count()) > 0) {
            await dataRows.first().click();
            for (const tab of ['Config', 'Versions', 'Lifecycle']) {
                await expect(page.getByRole('tab', { name: tab })).toBeVisible();
            }
        }
    });

    test('the new-pipeline action opens the create slide-over', async ({ page }) => {
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await page.getByRole('button', { name: 'New pipeline' }).first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText('New pipeline')).toBeVisible();
        await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(page.getByRole('dialog')).toBeHidden();
    });

    test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });

    test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
        // next-themes defaultTheme="system": emulating the media query flips
        // the .dark class without touching client storage.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await expectNoA11yViolations(page);
    });
});

function uniqueSlug() {
    return `e2e-pipeline-${Date.now()}`;
}

async function pipelineRow(page: Page, name: string, slug: string) {
    await page.getByLabel('Search').fill(slug);
    const row = page.locator('[data-slot="data-grid-row"]').filter({ hasText: name });
    await expect(row).toBeVisible();
    return row;
}

async function openLifecycle(page: Page) {
    const tab = page.getByRole('tab', { name: 'Lifecycle' });
    await tab.click();
    await expect(tab).toHaveAttribute('data-state', 'active');
}

const VALID_CONFIG_YAML = 'version: "1.0"\nmodels:\n  asr: whisper-large-v3';

async function createPipeline(page: Page, name: string, slug: string, configYaml: string) {
    await page.getByRole('button', { name: 'New pipeline' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New pipeline' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Slug').fill(slug);
    await dialog.getByLabel('Config YAML').fill(configYaml);
    await dialog.getByRole('button', { name: 'Create pipeline' }).click();
    await expect(dialog).toBeHidden();
    const detail = page.getByRole('dialog').filter({ hasText: name });
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Close' }).click();
    await expect(detail).toBeHidden();
}
async function deletePipeline(page: Page, name: string, slug: string) {
    const row = page.locator('[data-slot="data-grid-row"]').filter({ hasText: name });
    const detail = page.getByRole('dialog').filter({ hasText: name });
    if (await detail.isVisible()) {
        await openLifecycle(page);
    } else {
        await pipelineRow(page, name, slug);
        await row.click();
        await openLifecycle(page);
    }
    await page.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText(`Delete ${name}?`)).toBeVisible();
    await confirm.getByLabel(`Type ${slug} to confirm`).fill(slug);
    await confirm.getByRole('button', { name: 'Delete pipeline' }).click();
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(row).toBeHidden();
}

test.describe('audio pipelines: create + delete lifecycle (frame 34)', () => {
    test('creates a pipeline then deletes it via type-to-confirm', async ({ page }) => {
        const name = `E2E Pipeline ${Date.now()}`;
        const slug = uniqueSlug();
        const configYaml = VALID_CONFIG_YAML;

        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await createPipeline(page, name, slug, configYaml);
        await pipelineRow(page, name, slug);

        await deletePipeline(page, name, slug);
        await expect(page.locator('[data-slot="data-grid-row"]').filter({ hasText: name })).toBeHidden();
    });
});

test.describe('audio pipelines: create dialog validation (frame 34)', () => {
    test('keeps submit disabled until name, slug and YAML are filled', async ({ page }) => {
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await page.getByRole('button', { name: 'New pipeline' }).first().click();
        const dialog = page.getByRole('dialog');
        const submit = dialog.getByRole('button', { name: 'Create pipeline' });
        await expect(submit).toBeDisabled();

        await dialog.getByLabel('Name').fill('Validation Probe');
        await expect(submit).toBeDisabled();

        await dialog.getByLabel('Slug').fill('validation-probe');
        await expect(submit).toBeDisabled();

        await dialog.getByLabel('Config YAML').fill('version: "1.0"');
        await expect(submit).toBeEnabled();
    });

    test('rejects an invalid slug during create', async ({ page }) => {
        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await page.getByRole('button', { name: 'New pipeline' }).first().click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Name').fill('Bad Slug Pipeline');
        await dialog.getByLabel('Slug').fill('Bad Slug');
        await dialog.getByLabel('Config YAML').fill('version: "1.0"');

        const submit = dialog.getByRole('button', { name: 'Create pipeline' });
        await expect(submit).toBeEnabled();
        await submit.click();
        await expect(dialog).toBeVisible();
    });
});

test.describe('audio pipelines: selection, filters and lifecycle actions (frame 34)', () => {
    test('selecting a row populates the config editor and versions panel', async ({ page }) => {
        const name = `E2E Select ${Date.now()}`;
        const slug = uniqueSlug();
        const configYaml = VALID_CONFIG_YAML;

        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await createPipeline(page, name, slug, configYaml);
        const row = await pipelineRow(page, name, slug);

        await row.click();
        await expect(page.getByLabel(new RegExp(`Config YAML.*${slug}`))).toHaveValue(configYaml);
        const versionsTab = page.getByRole('tab', { name: 'Versions' });
        await versionsTab.click();
        await expect(versionsTab).toHaveAttribute('data-state', 'active');
        await expect(page.getByText('No config versions yet')).toBeVisible();

        await deletePipeline(page, name, slug);
    });

    test('search narrows the grid to matching pipelines', async ({ page }) => {
        const name = `E2E Search ${Date.now()}`;
        const slug = uniqueSlug();

        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await createPipeline(page, name, slug, VALID_CONFIG_YAML);
        const row = await pipelineRow(page, name, slug);

        await page.getByLabel('Search').fill(slug);
        await expect(row).toBeVisible();
        await expect(page.getByRole('grid', { name: 'Audio pipelines' }).locator('[data-slot="data-grid-row"]')).toHaveCount(1);

        await page.getByLabel('Search').fill('no-such-pipeline-xyz');
        await expect(page.getByText('No pipelines match your filters')).toBeVisible();

        await page.getByLabel('Search').fill('');
        await deletePipeline(page, name, slug);
    });

    test('the Status facet filters the grid by enabled/disabled', async ({ page }) => {
        const name = `E2E Status ${Date.now()}`;
        const slug = uniqueSlug();

        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await createPipeline(page, name, slug, VALID_CONFIG_YAML);
        const row = await pipelineRow(page, name, slug);

        await page.getByRole('button', { name: 'Filters', exact: true }).click();
        await page.getByRole('option', { name: 'On', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(/f=/);
        await expect(row).toBeVisible();

        await page.getByRole('button', { name: /^Filters/ }).click();
        await page.getByRole('option', { name: 'On', exact: true }).click();
        await page.getByRole('option', { name: 'Off', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(row).toBeHidden();

        await page.getByRole('button', { name: /^Filters/ }).click();
        await page.getByRole('option', { name: 'Off', exact: true }).click();
        await page.keyboard.press('Escape');

        await deletePipeline(page, name, slug);
    });

    test('the enable/disable toggle flips pipeline status', async ({ page }) => {
        const name = `E2E Toggle ${Date.now()}`;
        const slug = uniqueSlug();

        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await createPipeline(page, name, slug, VALID_CONFIG_YAML);
        const row = await pipelineRow(page, name, slug);
        await row.click();
        await openLifecycle(page);

        const toggleButton = page.getByRole('button', { name: 'Disable' });
        await expect(toggleButton).toBeVisible();
        await toggleButton.click();
        await expect(page.getByText(`${name} disabled`)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Enable' })).toBeVisible();

        await deletePipeline(page, name, slug);
    });

    test('type-to-confirm delete stays disabled until the exact slug is typed', async ({ page }) => {
        const name = `E2E Confirm ${Date.now()}`;
        const slug = uniqueSlug();

        await page.goto('/audio/pipelines');
        await waitForSettled(page);
        await createPipeline(page, name, slug, VALID_CONFIG_YAML);
        const row = await pipelineRow(page, name, slug);
        await row.click();
        await openLifecycle(page);

        await page.getByRole('button', { name: 'Delete' }).click();
        const confirm = page.getByRole('alertdialog');
        const confirmButton = confirm.getByRole('button', { name: 'Delete pipeline' });
        await expect(confirmButton).toBeDisabled();

        const typeToConfirmInput = confirm.getByLabel(`Type ${slug} to confirm`);
        await typeToConfirmInput.fill(`${slug}-wrong`);
        await expect(confirmButton).toBeDisabled();

        await typeToConfirmInput.fill(slug);
        await expect(confirmButton).toBeEnabled();

        await confirmButton.click();
        await expect(page.getByRole('alertdialog')).toBeHidden();
        await expect(row).toBeHidden();
    });
});
