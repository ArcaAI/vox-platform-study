/**
 * Authenticated-session helper for screen specs. The chromium project restores
 * the session saved by auth.setup.ts (storageState), so this normally just
 * verifies the console shell; it only falls back to the real login form when
 * no session is present (the gateway login route is throttled at 5/60s, so
 * per-test form logins are NOT viable at suite scale).
 * Callers must already have skip-gated on appAvailable() + apiAvailable().
 */

import { expect, type Page } from '@playwright/test';
import { ADMIN_CREDENTIALS } from './stack';

export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/dashboard');
  if (page.url().includes('/login')) {
    // No restored session — fall back to the form (rate-limited; rare).
    await page.getByLabel('Username').fill(ADMIN_CREDENTIALS.username);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_CREDENTIALS.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/dashboard');
  }
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/**
 * Impersonates the given (seeded) username via the BFF impersonate route.
 * Runs inside the page for the same cookie reason as selectWorkingTenant;
 * call after loginAsAdmin().
 *
 * The user search is scoped by the BFF to the elevated session's working
 * tenant, so a `limit=1` prefix search (e.g. "arcaai_doctor") can resolve to
 * the WRONG user ("arcaai_doctor_bren") and an earlier `selectWorkingTenant`
 * (which may have landed on a tenant this username does not belong to) can
 * make the search come back empty entirely. Search wide, match the username
 * EXACTLY, and if that still comes up empty, clear the working tenant (the
 * unscoped search reaches every tenant) and retry once before failing.
 */
export async function impersonateUser(page: Page, username: string): Promise<void> {
  const result = await page.evaluate(async (targetUsername) => {
    async function findUser(): Promise<{ id: string; username: string } | undefined> {
      const search = await fetch(
        `/api/hope/admin/users?search=${encodeURIComponent(targetUsername)}&searchFields=username&limit=50`,
      );
      if (!search.ok) return undefined;
      const body = (await search.json()) as { data?: Array<{ id: string; username: string }> };
      return body.data?.find((u) => u.username === targetUsername);
    }

    let user = await findUser();
    if (!user) {
      // A working tenant set by an earlier step scopes the search to that
      // tenant's users only — clear it and retry before giving up.
      await fetch('/api/auth/working-tenant', { method: 'DELETE' });
      user = await findUser();
    }
    if (!user) return `No seeded user named "${targetUsername}"`;

    const impersonate = await fetch('/api/auth/impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    });
    return impersonate.ok ? null : `Failed to impersonate "${targetUsername}" (${impersonate.status})`;
  }, username);
  if (result) throw new Error(result);
}

/**
 * Selects the first tenant as the elevated session's working tenant (the
 * tenant-scoped admin surfaces 400 without one). Runs inside the page so the
 * BFF session cookie (Secure; not sent by page.request over plain http)
 * applies; call after loginAsAdmin().
 */
export async function selectWorkingTenant(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const list = await fetch('/api/hope/admin/tenants?page=0&limit=20');
    if (!list.ok) return `Could not list tenants to pick a working tenant (${list.status})`;
    const body = (await list.json()) as { data?: Array<{ id: string; name?: string }> };
    const tenants = body.data ?? [];
    // Prefer a real tenant over the SYSTEM tenant (id 00000000-…, a
    // degenerate platform row whose tenant-scoped catalogs are empty and
    // whose storage listing errors); fall back to the first tenant.
    const tenant = tenants.find((t) => !t.id.startsWith('00000000')) ?? tenants[0];
    if (!tenant) return 'No tenants seeded; cannot select a working tenant';
    const set = await fetch('/api/auth/working-tenant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: tenant.id, tenantName: tenant.name }),
    });
    return set.ok ? null : `Failed to set working tenant (${set.status})`;
  });
  if (result) throw new Error(result);
}
