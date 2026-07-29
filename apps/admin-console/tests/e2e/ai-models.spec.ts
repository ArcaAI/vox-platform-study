/**
 * Frame 15 — AI Model Registry screen spec: authenticated smoke of the list
 * shell (h1 + registry region) and the rule 11 §11 axe gate in both themes.
 * Requires a running stack (skips otherwise, see helpers/stack.ts).
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

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
