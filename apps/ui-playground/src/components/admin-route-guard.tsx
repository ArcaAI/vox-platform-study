import type { ReactNode } from 'react';

import { Navigate } from '@tanstack/react-router';

import { useAuthStore } from '@/store/auth-store';

/**
 * Role-level guards for the admin route tree.
 *
 * These centralise the *route* gate so it can't drift from the sidebar nav.
 * Per TASK-327 ("scope, not visibility") any admin — SUPER_ADMIN or
 * TENANT_ADMIN — may reach the full admin console; the guard is role-level
 * only and does NOT itself scope data to a tenant.
 *
 * Per-tenant scoping is enforced server-side, but it is NOT automatic for a
 * super-admin: a super-admin has no implicit tenant, so they must explicitly
 * SELECT one (header ScopeSwitcher → `setTenant`), which the admin API client
 * sends as the `X-Tenant-Id` request header. The API only honours that header
 * for callers whose role permits cross-tenant access — the context interceptor
 * performs a role-gated elevation onto the requested tenant (TASK-331 r2605-A).
 * A TENANT_ADMIN cannot elevate: they are bound to their own session tenant and
 * any `X-Tenant-Id` they send for another tenant is ignored/rejected. Within a
 * tenant, CASL still enforces per-permission scoping.
 *
 * Previously every admin route re-implemented its own inline role check, which
 * drifted: Tenants / Departments / Prompts / Audio Pipelines were still gated
 * to SUPER_ADMIN only — so a TENANT_ADMIN saw those nav items but hit /403 —
 * and Prisma Studio had *no* guard at all (reachable by direct URL despite the
 * nav hiding it). Both predicates now come from the auth store so the nav and
 * the routes share one source of truth.
 */

/** Gate for every admin page (SUPER_ADMIN ∪ TENANT_ADMIN). */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  if (!isAdmin) {
    return <Navigate to="/403" />;
  }
  return <>{children}</>;
}

/**
 * Gate for global-scope-only surfaces (Prisma Studio — TASK-326 Q4).
 * SUPER_ADMIN only; a TENANT_ADMIN is redirected to /403.
 */
export function RequireGlobalScope({ children }: { children: ReactNode }) {
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  if (!isGlobalScope) {
    return <Navigate to="/403" />;
  }
  return <>{children}</>;
}
