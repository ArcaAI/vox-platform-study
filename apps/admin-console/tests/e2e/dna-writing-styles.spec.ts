/**
 * Frame 33 — DNA writing styles against a RUNNING stack (rule 12 gate 3):
 * screen smoke, one filter interaction, plus axe scans in both themes. Skips
 * with actionable messages when the app or gateway is down.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // DNA writing styles is tenant-scoped (tier 30-49): elevated sessions see
  // the "Select a working tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'DNA Writing Styles' })).toBeVisible();
  // Two empty variants: pristine ("No DNA reports yet") vs an active filter
  // ("No reports match your filters" — e.g. after toggling disabled=true).
  const emptyState = page.getByText(/No DNA reports yet|No reports match your filters/);
  // Data rows are focusable (row click -> doctor detail); skeleton rows are not.
  const dataRows = page.getByRole('grid', { name: 'DNA reports' }).locator('[data-slot="data-grid-row"]');
  await expect(dataRows.first().or(emptyState.first()).or(page.getByRole('alert').first())).toBeVisible();
}

test.describe('dna writing styles (frame 33)', () => {
  test('shows the header, dashboard roll-up strip and the fill-height grid', async ({ page }) => {
    // The dashboard card is now the pinned `stats` strip; the doctor
    // detail (and its PHI caption) moved into the detail slide-over,
    // shown only when a doctor row is selected.
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Doctors covered', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate report' }).first()).toBeVisible();
    await expect(page.getByRole('grid', { name: 'DNA reports' })).toBeVisible();
  });

  test('the include-disabled filter syncs the URL', async ({ page }) => {
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('option', { name: 'Include disabled' }).click();
    await expect(page).toHaveURL(/resourceStatus.*true/);
    await page.keyboard.press('Escape');
    await waitForSettled(page);
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);
    await expectNoA11yViolations(page);
  });
});

test.describe('dna writing styles — selection and generate flow (frame 33)', () => {
  test('the doctor filter syncs the URL', async ({ page }) => {
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);
    const dataRows = page.getByRole('grid', { name: 'DNA reports' }).locator('[data-slot="data-grid-row"]');
    const rowCount = await dataRows.count();
    test.skip(rowCount === 0, 'no seeded DNA reports to derive a doctor id from');
    const doctorId = (await dataRows.first().locator('span.font-mono').first().textContent())?.trim();
    test.skip(!doctorId, 'seeded row has no doctor id to filter on');

    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('textbox', { name: 'Doctor value' }).fill(doctorId!);
    await expect(page).toHaveURL(/doctorId/);
  });

  test('clear filters resets to the unfiltered grid', async ({ page }) => {
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);

    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('textbox', { name: 'Doctor value' }).fill('doctor-does-not-exist');
    await expect(page).toHaveURL(/doctorId/);
    await expect(page.getByText('No reports match your filters')).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/doctorId/);
    await waitForSettled(page);
  });

  test('clicking a row populates the doctor detail panel', async ({ page }) => {
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);
    const dataRows = page.getByRole('grid', { name: 'DNA reports' }).locator('[data-slot="data-grid-row"]');
    test.skip((await dataRows.count()) === 0, 'no seeded DNA reports to select');

    await dataRows.first().click();
    const panel = page.getByRole('dialog').filter({ has: page.getByText('Style text', { exact: true }) });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { level: 2 })).toBeVisible();
    await expect(panel.getByText('Select a doctor')).toHaveCount(0);
  });

  test('the generate report button is enabled before and after a row is selected', async ({ page }) => {
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);
    const dataRows = page.getByRole('grid', { name: 'DNA reports' }).locator('[data-slot="data-grid-row"]');
    test.skip((await dataRows.count()) === 0, 'no seeded DNA reports to select');

    const generateButton = page.getByRole('button', { name: 'Generate report' }).first();
    await expect(generateButton).toBeEnabled();

    await dataRows.first().click();
    await expect(generateButton).toBeEnabled();
  });

  test('the generate report dialog opens and shows the selected doctor', async ({ page }) => {
    await page.goto('/dna-writing-styles');
    await waitForSettled(page);
    const dataRows = page.getByRole('grid', { name: 'DNA reports' }).locator('[data-slot="data-grid-row"]');
    test.skip((await dataRows.count()) === 0, 'no seeded DNA reports to select');
    const doctorId = (await dataRows.first().locator('span.font-mono').first().textContent())?.trim();
    test.skip(!doctorId, 'seeded row has no doctor id to prefill the dialog with');

    await dataRows.first().click();
    await page.getByRole('button', { name: 'Generate report' }).first().click();

    const dialog = page.getByRole('dialog', { name: 'Generate DNA report' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Doctor ID' })).toHaveValue(doctorId!);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });
});
