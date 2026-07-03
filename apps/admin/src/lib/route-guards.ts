import { notFound, redirect } from '@tanstack/react-router';
import type { RouterContext } from '@/routes/__root';

/**
 * Route-level super-admin gate (TASK-394 P0-3 · R1 defense-in-depth).
 *
 * Applied to the pure-platform super-admin surfaces — Dashboard, Monitoring
 * (`system-health`), Roles & Policies, Settings — which already hide from the
 * nav (see `lib/nav.ts`) and 403 at the API. This `beforeLoad` closes the last
 * gap — a *direct URL hit* by a non-super-admin — by bouncing them to their own
 * tenant workspace. The server stays the source of truth; this only mirrors it
 * to avoid a flash of forbidden UI.
 *
 * NOT applied to `/tenants`: that list is the shared post-login landing and a
 * tenant-admin legitimately sees an API-scoped view of it (its cross-tenant
 * *management* affordances are already super-admin-gated in the component), so
 * a hard redirect there would regress the login flow.
 *
 * Redirect target is the viewer's own tenant (never a guarded surface, so no
 * redirect loop). A degraded session (authenticated, not super-admin, yet with
 * no tenant) can't be sent anywhere safe, so it terminates on the shared
 * not-found screen ("…or you don't have access to it").
 */
export function requireSuperAdmin(context: RouterContext): void {
  if (context.isSuperAdmin) return;
  if (context.tenantId) {
    throw redirect({ to: '/tenants/$tenantId', params: { tenantId: context.tenantId } });
  }
  throw notFound();
}
