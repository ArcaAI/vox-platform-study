/**
 * TASK-391 #22 (R3) — Roles & Policies · admin-console E2E (authored).
 *
 * Verifies the super-admin RBAC surface (`/roles`) wired to `usePolicies` /
 * `useRoles`, with the TASK-390 **anti-lockout** affordance: the seeded
 * system-critical GLOBAL policies (`system-full-access`, `rbac-system-manage`)
 * render a **Protected** badge and a **disabled Delete** — mirroring the server
 * guard that refuses to delete/disable them (defense in depth).
 *
 * Runs in all three viewport projects (desktop/tablet/mobile — the tables
 * degrade via horizontal scroll below `md`). No TARGET flow is asserted.
 *
 * Run status: authored — executes only against a live admin app + seeded API
 * (config `webServer` boots the app; the SDK needs the gateway). Deferred this
 * round (see docs/implementation/TASK-391-Super-Admin-Tier-FE/README.md §3.5).
 *
 * @see docs/designs/admin/unbuilt-super-admin-surfaces.md §5.1
 */
import { test, expect } from './fixtures/auth';

test.describe('TASK-391 — Roles & Policies (#22 anti-lockout)', () => {
  test.beforeEach(async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    await page.goto('/roles');
    await expect(page.getByRole('heading', { name: 'Roles & Policies' })).toBeVisible();
  });

  test('exposes the Roles and Policies tabs + create affordances', async ({ page }) => {
    await expect(page.getByRole('tab', { name: 'Roles' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Policies' })).toBeVisible();
    // Roles tab is the default → New role.
    await expect(page.getByRole('button', { name: 'New role' })).toBeVisible();
  });

  test('#22 · protected system policies show Protected + a disabled Delete', async ({ page }) => {
    await page.getByRole('tab', { name: 'Policies' }).click();
    await expect(page.getByRole('button', { name: 'New policy' })).toBeVisible();

    // Anti-lockout: the seeded `system-full-access` / `rbac-system-manage`
    // GLOBAL policies cannot be deleted; the console disables their Delete.
    const protectedDelete = page.getByRole('button', { name: /protected system policy — cannot be deleted/i });
    await expect(protectedDelete.first()).toBeVisible();
    await expect(protectedDelete.first()).toBeDisabled();
    // …and they carry the Protected badge.
    await expect(page.getByText('Protected').first()).toBeVisible();
  });

  test('#22 · the CASL policy builder dialog opens for creating a policy', async ({ page }) => {
    await page.getByRole('tab', { name: 'Policies' }).click();
    await page.getByRole('button', { name: 'New policy' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Visual CASL rule-builder + Advanced (JSON) fallback (TASK-374 editor).
    await expect(dialog.getByRole('tab', { name: 'Builder' })).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Advanced (JSON)' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
