/**
 * TASK-404 P2-1 — real chart series on the platform surfaces.
 *
 * Proves the dashboards render REAL recharts series (never illustrative rects):
 *   - `/dashboard` consultation chart: accessible `role="img"` chart with its
 *     sr-only data-table fallback and the two bucketed series (New / Re-visit)
 *     driven by `bucketConsultations` — zero-filled buckets mean the chart
 *     renders even when the seeded range has no sessions.
 *   - `/system-health` request volume: REAL `requestVolumeSeries` (TASK-386 E1)
 *     as an area chart when Prometheus reports, else the honest empty state —
 *     exactly one of the two, and never the retired fake range/tenant controls.
 *
 * Non-destructive: navigation + rendering only.
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-404 P2-1 — real chart series', () => {
  test.beforeEach(async ({ loginAs }) => {
    await loginAs('superAdmin');
  });

  test('platform dashboard consultation chart renders a real recharts series', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Platform Dashboard' })).toBeVisible();

    // Accessible chart visual + its offscreen data-table fallback.
    const chart = page.getByRole('img', { name: /Consultation sessions per day/ });
    await expect(chart).toBeVisible();
    await expect(chart.locator('svg')).toBeVisible();

    const chartWrapper = page.locator('[data-slot="metric-chart"][data-kind="bar"]').first();
    const srTable = chartWrapper.locator('table[data-slot="metric-chart-table"]');
    await expect(srTable).toHaveCount(1);
    // Two real series columns, driven by CHART_SERIES (never placeholder rects).
    await expect(srTable.locator('thead th').nth(1)).toHaveText('New');
    await expect(srTable.locator('thead th').nth(2)).toHaveText('Re-visit');
    // Zero-filled bucketing yields one row per bucket (≥1 always).
    expect(await srTable.locator('tbody tr').count()).toBeGreaterThanOrEqual(1);

    // The recharts series layers exist inside the svg (one per series).
    expect(await chart.locator('svg g.recharts-bar').count()).toBeGreaterThanOrEqual(1);
  });

  test('request-volume renders the real series or the honest empty state (never fake controls)', async ({ page }) => {
    await page.goto('/system-health');
    await expect(page.getByRole('heading', { name: 'Service Monitoring' })).toBeVisible();

    // Exactly one of: REAL area chart (Prometheus reporting) or honest empty state.
    const realChart = page.getByRole('img', { name: /Requests and open sockets per minute/ });
    const emptyState = page.getByText('No request-volume samples');
    await expect(realChart.or(emptyState).first()).toBeVisible();
    const [chartCount, emptyCount] = [await realChart.count(), await emptyState.count()];
    expect(chartCount + emptyCount).toBe(1);

    if (chartCount === 1) {
      // Real series: area layers + the sr-only table with both series columns.
      await expect(realChart.locator('svg')).toBeVisible();
      const srTable = page.locator('[data-slot="metric-chart"][data-kind="area"] table[data-slot="metric-chart-table"]');
      await expect(srTable.locator('thead th').nth(1)).toHaveText('Requests / min');
      await expect(srTable.locator('thead th').nth(2)).toHaveText('Open sockets');
      expect(await srTable.locator('tbody tr').count()).toBeGreaterThanOrEqual(1);
    }

    // The misleading per-card range/tenant controls were retired with the fake chart.
    await expect(page.getByLabel('Scope request volume by tenant')).toHaveCount(0);
    // Fixed live window is stated instead.
    await expect(page.getByText(/live, last 30 min/)).toBeVisible();
  });
});
