/**
 * TASK-932 Lane T — storage browser "All tenants" view against a RUNNING
 * stack (rule 12 gate 3): an unscoped platform admin (no working tenant) used
 * to hit the "Select a working tenant" gate on `/storage`; it now sees every
 * tenant's registered buckets merged with the physical bucket list instead
 * (`GET storage/buckets?includePhysical=true`), with a Tenant column. Once a
 * working tenant is selected, the screen falls back to the EXISTING
 * tenant-scoped behaviour, which `storage-browser.spec.ts` already covers in
 * depth (upload/download/delete, search, both-theme axe) — this spec only
 * proves the new scope switch and scans the new "All tenants" view itself.
 */

import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/a11y';
import { loginAsAdmin } from './helpers/auth';
import { API_DOWN_MESSAGE, APP_DOWN_MESSAGE, apiAvailable, appAvailable } from './helpers/stack';

/**
 * `selectWorkingTenant` (helpers/auth.ts) deliberately picks the first
 * non-SYSTEM tenant, whichever that is — fine for screens that only need
 * *a* working tenant. This lane needs a SPECIFIC named tenant (ArcaAI) to
 * prove the listing narrows to exactly that tenant's buckets, so it mirrors
 * that helper locally (same fetch-through-the-page shape, for the same
 * BFF-cookie reason) rather than widening the shared helper's contract.
 */
async function selectWorkingTenantByName(page: Page, name: string): Promise<void> {
  const result = await page.evaluate(async (tenantName) => {
    const list = await fetch('/api/hope/admin/tenants?page=0&limit=20');
    if (!list.ok) return `Could not list tenants to pick a working tenant (${list.status})`;
    const body = (await list.json()) as { data?: Array<{ id: string; name?: string }> };
    const tenant = body.data?.find((t) => t.name === tenantName);
    if (!tenant) return `No seeded tenant named "${tenantName}"`;
    const set = await fetch('/api/auth/working-tenant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: tenant.id, tenantName: tenant.name }),
    });
    return set.ok ? null : `Failed to set working tenant (${set.status})`;
  }, name);
  if (result) throw new Error(result);
}

test.describe('storage browser — "All tenants" view (TASK-932)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await appAvailable()), APP_DOWN_MESSAGE);
    test.skip(!(await apiAvailable()), API_DOWN_MESSAGE);
    // Deliberately no selectWorkingTenant() here — the whole point of this
    // spec is the UNSCOPED (no working tenant) session.
    await loginAsAdmin(page);
  });

  test('an unscoped super admin sees buckets from more than one tenant, with a Tenant column; selecting ArcaAI as the working tenant narrows the list', async ({
    page,
  }) => {
    await page.goto('/storage');
    await expect(page.getByRole('heading', { level: 1, name: 'Storage' })).toBeVisible();

    const grid = page.getByRole('grid', { name: 'Storage buckets across all tenants' });
    await expect(grid).toBeVisible();
    const rows = grid.locator('[data-slot="data-grid-row"]');
    await expect(rows.first()).toBeVisible();

    // Column order is Bucket, Tenant, Status, Created, Actions — the Tenant
    // cell is the second gridcell in each row.
    const tenantCells = await rows.evaluateAll((elements) =>
      elements
        .map((row) => row.querySelectorAll('[role="gridcell"]')[1]?.textContent?.trim())
        .filter((text): text is string => !!text && text !== '—'),
    );
    expect(new Set(tenantCells).size).toBeGreaterThan(1);

    await selectWorkingTenantByName(page, 'ArcaAI');
    await page.reload();

    // Back to the CURRENT tenant-scoped behaviour (storage-browser.spec.ts):
    // the bucket <Select>, never the cross-tenant grid.
    await expect(page.getByRole('combobox', { name: /bucket/i })).toBeVisible();
    await expect(grid).not.toBeVisible();
    await expect(page.getByText('tenant-scoped listing only')).toBeVisible();
  });

  test('has no WCAG 2.2 AA violations in the "All tenants" view (light)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/storage');
    await expect(page.getByRole('grid', { name: 'Storage buckets across all tenants' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('has no WCAG 2.2 AA violations in the "All tenants" view (dark)', async ({ page }) => {
    // next-themes defaultTheme="system": emulating the media query flips
    // the .dark class without touching client storage.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/storage');
    await expect(page.getByRole('grid', { name: 'Storage buckets across all tenants' })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
