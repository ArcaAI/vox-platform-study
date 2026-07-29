/**
 * These two retired routes keep a `redirect()` page for ONE release so
 * bookmarks and deep links survive:
 *
 *   /prompt-studio → /agents?tab=governance   (governance folded in)
 *   /pstudio       → /db-studio               (console-only rename)
 *
 * The vitest specs assert the page modules CALL `redirect()` with those targets;
 * these assert the redirect actually resolves to a working screen in a browser —
 * a correct `redirect()` to a route that 404s or gates the user out is still a
 * broken bookmark. When the redirect pages are deleted (next release), delete
 * this file with them.
 */

import { expect, test } from '@playwright/test';
import { loginAsAdmin, selectWorkingTenant } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

test.describe('retired route redirects', () => {
  test('/prompt-studio lands on the /agents Governance tab', async ({ page }) => {
    // `/agents` is tenant-scoped, so an elevated session needs a working
    // tenant before the tabs mount at all. This is NOT a regression from the
    // fold: `/prompt-studio` was `WorkingTenantGate`d too (a global-admin-only
    // screen over per-tenant data), so both surfaces required a tenant before
    // and after.
    await selectWorkingTenant(page);
    await page.goto('/prompt-studio');

    await expect(page).toHaveURL(/\/agents\?tab=governance/);
    await expect(page.getByRole('heading', { level: 1, name: 'Agents & Prompt Templates' })).toBeVisible();
    // The fold is only useful if the tab it points at is actually selected.
    await expect(page.getByRole('tab', { name: 'Governance' })).toHaveAttribute('data-state', 'active');
  });

  test('/pstudio lands on /db-studio', async ({ page }) => {
    await page.goto('/pstudio');

    await expect(page).toHaveURL(/\/db-studio/);
    await expect(page.getByRole('heading', { level: 1, name: 'Database Studio' })).toBeVisible();
  });
});
