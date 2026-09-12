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

test.describe('tenant profile screen', () => {
  test('renders the tenant identity card', async ({ page }) => {
    await page.goto('/tenant-profile');
    await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Organization' })).toBeVisible();
  });

  test('switches between the organization and plan & usage tabs', async ({ page }) => {
    await page.goto('/tenant-profile');
    await expect(page.getByRole('region', { name: 'Organization' })).toBeVisible();

    for (const name of ['Organization', 'Plan & usage']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
    // TASK-956: the Settings tab is retired — /settings and /settings-registry own those rows.
    await expect(page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Plan & usage' }).click();
    await expect(page).toHaveURL(/tab=plan/);
    await expect(page.getByText('Resolved limits and live usage for this tenant.')).toBeVisible();
  });

  test('points at the two settings editors from the Organization tab', async ({ page }) => {
    await page.goto('/tenant-profile');
    const pointer = page.getByRole('region', { name: 'Settings' });
    await expect(pointer).toBeVisible();
    await expect(pointer.getByRole('link', { name: /Settings registry/ })).toHaveAttribute('href', '/settings-registry');
    await expect(pointer.getByRole('link', { name: /Settings rows & secrets/ })).toHaveAttribute('href', '/settings');
  });

  test('sends the retired ?tab=settings deep link to the Organization tab', async ({ page }) => {
    await page.goto('/tenant-profile?tab=settings');
    await expect(page.getByRole('tab', { name: 'Organization', selected: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Organization' })).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/tenant-profile');
    await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Organization' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/tenant-profile');
    await expect(page.getByRole('heading', { level: 1, name: 'Tenant profile' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Organization' })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
