/**
 * TASK-394 P0-3 — route-level super-admin guard (R1 · defense-in-depth).
 *
 * The pure-platform super-admin surfaces — Dashboard, Monitoring
 * (`system-health`), Roles & Policies, Settings — previously relied on nav-hide
 * + API-403 only. This spec proves the new `beforeLoad` guard
 * (`src/lib/route-guards.ts`, threaded via the router context in `main.tsx`):
 *   - `super_admin` opens each guarded surface (its heading renders), and
 *   - a `tenant_admin` hitting the same URL *directly* (a hard `goto`, so the
 *     guard runs on the rehydrated session) is bounced off it to their own
 *     tenant workspace and never sees the surface.
 *
 * `/tenants` is intentionally NOT guarded — it is the shared post-login landing
 * and a tenant-admin legitimately sees an API-scoped view of it — so that flow
 * is untouched (see `task-391-nav-visibility`).
 *
 * Runs in all three viewport projects (the guard is viewport-agnostic).
 * Non-destructive: navigation only, no mutations.
 */
import { test, expect } from './fixtures/auth';

/** The four pure-platform surfaces guarded by `requireSuperAdmin` + their page heading. */
const GUARDED = [
  { path: '/dashboard', heading: 'Platform Dashboard' },
  { path: '/system-health', heading: 'Service Monitoring' },
  { path: '/roles', heading: 'Roles & Policies' },
  { path: '/settings', heading: 'Settings' },
] as const;

test.describe('TASK-394 P0-3 — super-admin route guard', () => {
  test('super-admin opens every guarded platform surface', async ({ page, loginAs }) => {
    await loginAs('superAdmin');
    for (const { path, heading } of GUARDED) {
      await page.goto(path);
      await page.waitForURL(`**${path}`, { timeout: 15_000 });
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  test('tenant-admin is redirected off every guarded platform surface', async ({ page, loginAs }) => {
    await loginAs('tenantAdmin');
    for (const { path, heading } of GUARDED) {
      await page.goto(path);
      // Security property: a non-super-admin is NEVER left on the guarded
      // surface. The route guard bounces them to their own tenant workspace
      // (`/tenants/$tenantId`); on a cold hard-load the auth guard may first
      // bounce through `/login` — either way the path is left and the
      // platform surface never renders. (If the guard were removed they'd
      // stay on `path` with the heading visible → this fails.)
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).not.toBe(path);
      await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
    }
  });
});
