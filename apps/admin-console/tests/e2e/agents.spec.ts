/**
 * Frame 32 — Agent Catalog against a RUNNING stack (rule 12 gate 3).
 *
 * This screen now owns exactly one resource, the `DepartmentAgent` catalog:
 * TASK-634 R6 moved the prompt-template grid and the governance surface to
 * `/prompt-templates` (covered by `prompt-templates.spec.ts`), so what remains
 * here is the catalog smoke, the deep link out, and the axe gate.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
  // Agents are tenant-scoped: elevated sessions see the "Select a working
  // tenant" gate until one is chosen.
  await selectWorkingTenant(page);
});

async function waitForSettled(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Catalog' })).toBeVisible();
}

test.describe('agent catalog (frame 32)', () => {
  test('shows the catalog header and no longer carries the template tabs', async ({ page }) => {
    await page.goto('/agents');
    await waitForSettled(page);
    await expect(page.getByRole('tab', { name: 'Agent Templates' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Governance' })).toHaveCount(0);
  });

  test('deep-links to the prompt-template surface', async ({ page }) => {
    await page.goto('/agents');
    await waitForSettled(page);
    // Distinct from the sidebar nav entry of the same destination.
    await page.getByRole('link', { name: 'Open prompt templates' }).click();
    await expect(page).toHaveURL(/\/prompt-templates/);
    await expect(page.getByRole('heading', { level: 1, name: 'Prompt Instruction Templates' })).toBeVisible();
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
