/**
 * Frame 11 — Monitoring screen spec: loaded regions + the rule 11 §11 axe
 * gate in both themes. Skips when the stack is not running.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

test.beforeEach(async ({ page }) => {
  test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
  test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
  await loginAsAdmin(page);
});

async function assertLoadedMonitoring(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
  // One meaningful region per data source: probe grid + Redis health card.
  await expect(page.getByRole('heading', { level: 2, name: 'Service health' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Redis health' })).toBeVisible();
  await expect(page.getByText('Services healthy').first()).toBeVisible();
}

test.describe('monitoring', () => {
  test('renders loaded regions with no WCAG 2.2 AA violations (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/monitoring');
    await assertLoadedMonitoring(page);
    await expectNoA11yViolations(page);
  });

  test('renders loaded regions with no WCAG 2.2 AA violations (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/monitoring');
    await assertLoadedMonitoring(page);
    await expectNoA11yViolations(page);
  });

  test('renders the active sessions region with rows or the empty state', async ({ page }) => {
    await page.goto('/monitoring');
    await assertLoadedMonitoring(page);
    const region = page.getByRole('region', { name: 'Active sessions' });
    await expect(region).toBeVisible();
    const list = region.getByRole('list', { name: 'Active sessions by service' });
    const hasRows = await list.isVisible().catch(() => false);
    if (hasRows) {
      await expect(list.locator('li').first()).toBeVisible();
      await expect(region.getByText(/unique users$/)).toBeVisible();
    } else {
      await expect(region.getByText(/Couldn.t load sessions/)).toBeVisible();
    }
  });

  test('renders the response-time chart region or its empty state', async ({ page }) => {
    await page.goto('/monitoring');
    await assertLoadedMonitoring(page);
    const chart = page.getByRole('img', { name: 'Latest response time by service' });
    const hasChart = await chart.isVisible().catch(() => false);
    if (hasChart) {
      await expect(chart).toBeVisible();
    } else {
      await expect(page.getByText('No samples in window')).toBeVisible();
    }
  });

  test('shows the auto-refresh footer with the last-updated time', async ({ page }) => {
    await page.goto('/monitoring');
    await assertLoadedMonitoring(page);
    await expect(page.getByText(/^Auto-refresh 30s/)).toBeVisible();
  });

  test('shows per-probe error detail for an unhealthy or degraded service', async ({ page }) => {
    // moved this onto the admin plane (`admin/health/services`); the mock
    // still pointed at the pre-move path, so it never matched and the test asserted
    // against the REAL response, which has no E2E probe in it.
    await page.route('**/api/hope/admin/health/services', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'degraded',
          timestamp: new Date().toISOString(),
          services: {
            e2e: {
              status: 'degraded',
              service: 'E2E probe',
              duration_ms: 100,
              error: 'E2E probe failure',
            },
          },
        }),
      });
    });
    await page.goto('/monitoring');
    await assertLoadedMonitoring(page);
    const serviceList = page.getByRole('list', { name: 'Service health' });
    await expect(serviceList.getByText('E2E probe failure', { exact: true })).toBeVisible();
  });
});
