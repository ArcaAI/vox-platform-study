/**
 * TASK-380 — Tenant Dashboard (frame 18d) frontend E2E.
 *
 * Browser-driven, full-stack: drives the real admin UI (Vite :5174) → API
 * Gateway (:8868). Exercises the `18d` Tenant Dashboard (tenant Overview tab) at
 * the Desktop / Tablet / Mobile viewport projects (see playwright.config.ts).
 *
 * Coverage:
 *   - the dashboard's core regions render (headline + secondary KPI tiles, the
 *     consultation MetricChart, the recent-activity feed, the audio-pipeline strip);
 *   - the focal controls: the Week/Month/Year DateRangeSelector + the super-admin
 *     cross-tenant TenantFilter;
 *   - super-admin vs tenant-admin scope (tenant-admin gets the read-only banner and
 *     NO cross-tenant filter);
 *   - the KPI grid reflows 1 → 2 → 4 across mobile / tablet / desktop.
 *
 * Generic responsive primitives (shell icon-rail, table→card, dialog full-screen)
 * are owned by TASK-384 and asserted there, not here.
 *
 * RUN (needs a seeded stack — see e2e/README.md): the API on :8868 must be up;
 * the config auto-starts the admin dev server. DISCOVER WITHOUT A STACK:
 *   pnpm exec playwright test --config apps/admin/playwright.config.ts --list
 */
import { test, expect, type Page } from './fixtures/auth';

const SEEDED_GLOBAL_TENANT_KEY = '__GLOBAL__';

/** Expected headline-KPI column count per viewport project (grid-cols-1 sm:grid-cols-2 xl:grid-cols-4). */
const EXPECTED_KPI_COLUMNS: Record<string, number> = { mobile: 1, tablet: 2, desktop: 4 };

interface TenantListItem {
  id: string;
  name: string;
  key?: string;
}

/** sessionStorage key the admin auth store persists under (STORAGE_KEYS.AUTH). */
const AUTH_STORAGE_KEY = 'hope.admin.auth';

/**
 * Resolve a data-bearing tenant id from `GET /admin/tenants` (viewport-independent
 * — avoids clicking virtualized grid rows / mobile cards). Prefers the seeded
 * `__GLOBAL__` tenant, which has seeded users/departments/consultations so the
 * dashboard renders its non-empty (main) state rather than the empty variant.
 *
 * `loginAs` already authenticated us and landed on `/tenants`, so the bearer is
 * in sessionStorage — fetch the list directly with it rather than forcing a
 * second hard `goto('/tenants')`. Under parallel load that redundant reload can
 * race the post-reload auth rehydration (an early unauthenticated request →
 * 401 → refresh → `logout()` → bounce to `/login`), which flaked this helper.
 */
async function resolveTenantId(page: Page): Promise<string> {
  const token = await page.evaluate((key) => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? ((JSON.parse(raw)?.state?.accessToken as string) ?? '') : '';
    } catch {
      return '';
    }
  }, AUTH_STORAGE_KEY);
  expect(token, 'loginAs persisted a bearer token').toBeTruthy();

  // baseURL is the Vite dev server, which proxies /api → the API gateway.
  const res = await page.request.get('/api/v1/admin/tenants', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok(), `GET /admin/tenants → ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { data?: TenantListItem[] };
  const tenants = body.data ?? [];
  expect(tenants.length, 'seed ships at least one tenant').toBeGreaterThan(0);
  const preferred = tenants.find((t) => t.key === SEEDED_GLOBAL_TENANT_KEY) ?? tenants[0];
  return preferred.id;
}

/** Land on a tenant's `18d` dashboard and wait until the KPI row has rendered. */
async function openDashboard(page: Page): Promise<string> {
  const tenantId = await resolveTenantId(page);
  await page.goto(`/tenants/${tenantId}/overview`);
  // "Active users" labels every non-error dashboard state (main + empty), so it
  // is the safe "the dashboard rendered" signal.
  await expect(page.getByText('Active users', { exact: true })).toBeVisible();
  return tenantId;
}

test.describe('TASK-380 — Tenant Dashboard (18d)', () => {
  test('super-admin: renders the headline + secondary KPI tiles', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openDashboard(page);

    // Scope KPI labels to the stat-card tiles: labels like "Departments" otherwise
    // collide with the sidebar nav link of the same name (strict-mode violation).
    const statCards = page.locator('[data-slot="stat-card"]');
    // Headline KPI row (TD1).
    for (const label of ['Active users', 'Departments', 'Running sessions', 'Services healthy']) {
      await expect(statCards.getByText(label, { exact: true })).toBeVisible();
    }
    // Secondary KPI row (TD2) — incl. the drawn-but-TARGET tiles (Open sockets / Consumption).
    for (const label of ['Open sockets', 'Processing jobs', 'Consultations today', 'Pending review', 'Consumption']) {
      await expect(statCards.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test('super-admin: renders the chart, activity feed and audio-pipeline strip', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openDashboard(page);

    // Focal consultation chart (TD3): card heading + the accessible chart figure.
    await expect(page.getByRole('heading', { name: 'Consultation sessions' })).toBeVisible();
    await expect(page.getByRole('img', { name: /Consultation sessions per day/i })).toBeVisible();

    // Recent-activity audit feed (TD4).
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
    await expect(page.getByLabel('Recent tenant activity')).toBeVisible();

    // Audio-pipeline strip (TD5): heading + the canonical first stage.
    await expect(page.getByRole('heading', { name: 'Audio pipeline' })).toBeVisible();
    await expect(page.getByText('STT', { exact: true })).toBeVisible();
  });

  test('super-admin: shows the cross-tenant TenantFilter and the Week/Month/Year range control', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openDashboard(page);

    // TenantFilter renders only for super-admins (with tenant options loaded).
    await expect(page.getByRole('combobox', { name: 'Switch tenant dashboard' })).toBeVisible();

    // DateRangeSelector preset group + its three presets.
    await expect(page.getByRole('group', { name: 'Date range preset' })).toBeVisible();
    for (const preset of ['Week', 'Month', 'Year']) {
      await expect(page.getByRole('radio', { name: preset })).toBeVisible();
    }
    // Switching the preset keeps the chart mounted (re-buckets client-side).
    await page.getByRole('radio', { name: 'Month' }).click();
    await expect(page.getByRole('img', { name: /Consultation sessions per day/i })).toBeVisible();
  });

  test('tenant-admin: read-only scope, NO cross-tenant filter', async ({ page, loginAs }) => {
    await loginAs('tenantAdmin');
    await openDashboard(page);

    // Read-only banner copy (the tenant-admin variant, frame 120:11341).
    await expect(page.getByText(/Read-only metrics view scoped to your organization/i)).toBeVisible();

    // The cross-tenant switcher is absent for a tenant-admin…
    await expect(page.getByRole('combobox', { name: 'Switch tenant dashboard' })).toHaveCount(0);
    // …but the date-range control is still available.
    await expect(page.getByRole('group', { name: 'Date range preset' })).toBeVisible();
  });

  test('KPI grid reflows 1 → 2 → 4 across mobile / tablet / desktop', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await openDashboard(page);

    // The headline KPI grid is the nearest grid ancestor of the "Active users" tile.
    const headlineGrid = page
      .locator('[data-slot="stat-card"]', { hasText: 'Active users' })
      .locator('xpath=ancestor::div[contains(@class,"grid")][1]');
    const columns = await headlineGrid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);

    const projectName = test.info().project.name;
    const expected = EXPECTED_KPI_COLUMNS[projectName];
    expect(expected, `unknown viewport project "${projectName}"`).toBeGreaterThan(0);
    expect(columns, `headline KPI columns @ ${projectName}`).toBe(expected);
  });
});
