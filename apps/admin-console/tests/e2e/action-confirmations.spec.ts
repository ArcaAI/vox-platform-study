/**
 * TASK-1057 — Action confirmations (platform admin): the screen renders against the live stack,
 * axe gate in both themes (rule 11 §11), locked rows offer no control, and apply-to-all stages
 * edits without saving. Written, not run here.
 */

import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

async function openScreen(page: import('@playwright/test').Page) {
  await page.goto('/action-confirmations');
  await expect(page.getByRole('heading', { level: 1, name: 'Action confirmations' })).toBeVisible();
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
}

test.describe('action confirmations screen', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`renders with no WCAG 2.2 AA violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openScreen(page);
      await expectNoA11yViolations(page);
    });
  }

  test('locked rows have no control; apply-to-all stages without saving', async ({ page }) => {
    await openScreen(page);
    await expect(page.getByText('Always required — cannot be switched off').first()).toBeVisible();
    await page.getByRole('button', { name: 'Set all Reason to Not required' }).click();
    await expect(page.getByText(/unsaved change/)).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByText('No unsaved changes')).toBeVisible();
  });
});
