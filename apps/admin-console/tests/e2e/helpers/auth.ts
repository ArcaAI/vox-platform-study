/**
 * Authenticated-session helper for screen specs: signs in through the real
 * login form as the seeded global admin and waits for the console shell.
 * Callers must already have skip-gated on appAvailable() + apiAvailable().
 */

import { expect, type Page } from '@playwright/test';
import { ADMIN_CREDENTIALS } from './stack';

export async function loginAsAdmin(page: Page): Promise<void> {
    await page.goto('/login');
    await page.getByLabel('Username').fill(ADMIN_CREDENTIALS.username);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN_CREDENTIALS.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/**
 * Selects the first tenant as the elevated session's working tenant (the
 * tenant-scoped admin surfaces 400 without one). Runs inside the page so the
 * BFF session cookie (Secure; not sent by page.request over plain http)
 * applies; call after loginAsAdmin().
 */
export async function selectWorkingTenant(page: Page): Promise<void> {
    const result = await page.evaluate(async () => {
        const list = await fetch('/api/hope/admin/tenants?page=0&limit=1');
        if (!list.ok) return `Could not list tenants to pick a working tenant (${list.status})`;
        const body = (await list.json()) as { data?: Array<{ id: string; name?: string }> };
        const tenant = (body.data ?? [])[0];
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
