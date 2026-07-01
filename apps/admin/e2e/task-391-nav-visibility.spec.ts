/**
 * TASK-391 follow-up — per-surface nav visibility (CASL-mirrored).
 *
 * User decision: gate each super-admin-tier surface **per-surface** (NOT blanket
 * super-admin). API Keys + Audit are admin-tier (tenant-admin OR super-admin —
 * they legitimately manage their own tenant's keys/audit); Roles & Policies +
 * Global Settings are super-admin only. The server CASL remains the enforcement
 * backstop; this only controls sidebar visibility (`lib/nav.ts` `getNavSections`).
 *
 * Runs in all three viewport projects (the sidebar collapses behind a drawer
 * below the `md` 768px breakpoint).
 */
import type { Page } from '@playwright/test';
import { test, expect, type PersonaKey } from './fixtures/auth';

/** Login, wait for the shell, then return the Primary nav (opening the mobile drawer when collapsed). */
async function primaryNav(page: Page, loginAs: (p: PersonaKey) => Promise<void>, persona: PersonaKey) {
    await loginAs(persona); // lands on /tenants with the SPA loaded
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
    if ((page.viewportSize()?.width ?? 1280) < 768) {
        await page.getByRole('button', { name: 'Open navigation' }).click();
    }
    return page.getByRole('navigation', { name: 'Primary' });
}

test.describe('TASK-391 — per-surface nav visibility', () => {
    test('super-admin sees all four super-admin-tier surfaces', async ({ page, loginAs }) => {
        const nav = await primaryNav(page, loginAs, 'superAdmin');
        await expect(nav.getByRole('link', { name: 'Roles & Policies' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'API Keys' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Audit Log' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
    });

    test('tenant-admin sees API Keys + Audit but not Roles & Policies or Settings', async ({ page, loginAs }) => {
        const nav = await primaryNav(page, loginAs, 'tenantAdmin');
        // admin-tier surfaces — visible to a tenant-admin
        await expect(nav.getByRole('link', { name: 'API Keys' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Audit Log' })).toBeVisible();
        // super-admin-only surfaces — hidden from a tenant-admin
        await expect(nav.getByRole('link', { name: 'Roles & Policies' })).toHaveCount(0);
        await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    });
});
