/**
 * TASK-404 P2-5 — Monitoring on the shared metrics primitives (TASK-377 follow-up).
 *
 * Proves `/system-health` composes the canonical `@arcaai/ui/components/metrics`
 * set after the migration:
 *   - ≥4 KPI `StatCard`s (data-slot="stat-card"),
 *   - the canonical `ServiceStatusBar` footer strip (data-slot="service-status-bar",
 *     polite `role="status"`), with the full per-service list on md+ and the
 *     collapsed "N/M healthy" summary chip on mobile, plus a ≥44px Refresh button,
 *   - Services + Models `MetricTable`s stay intact.
 *
 * Non-destructive: navigation + rendering + one Refresh click (a read refetch).
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-404 P2-5 — system-health on shared metrics components', () => {
  test.beforeEach(async ({ loginAs, page }) => {
    await loginAs('superAdmin');
    await page.goto('/system-health');
    await expect(page.getByRole('heading', { name: 'Service Monitoring' })).toBeVisible();
  });

  test('KPI StatCards and both MetricTables render', async ({ page }) => {
    expect(await page.locator('[data-slot="stat-card"]').count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByRole('table', { name: 'Service health' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Models and running tasks' })).toBeVisible();
  });

  test('canonical ServiceStatusBar renders as the footer strip', async ({ page }, testInfo) => {
    const bar = page.locator('[data-slot="service-status-bar"]');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('role', 'status');

    if (testInfo.project.name === 'mobile') {
      // Collapsed summary chip ("N/M healthy") on narrow widths.
      const summary = bar.locator('[data-slot="service-status-summary"]');
      await expect(summary).toBeVisible();
      await expect(summary).toHaveText(/\d+\/\d+ healthy/);
    } else {
      // Full per-service list (6 canonical services) on md+.
      const list = bar.locator('[data-slot="service-status-list"]');
      await expect(list).toBeVisible();
      await expect(list.locator('[data-slot="service-status-item"]')).toHaveCount(6);
      await expect(list.getByText('Guardrail', { exact: true })).toBeVisible();
    }

    // ≥44px touch-target Refresh wired to refreshAll.
    const refresh = bar.getByRole('button', { name: 'Refresh' });
    await expect(refresh).toBeVisible();
    const box = await refresh.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await refresh.click();
    await expect(bar).toBeVisible();
  });
});
