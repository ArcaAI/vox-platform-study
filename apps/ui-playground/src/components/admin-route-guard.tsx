import type { ReactNode } from 'react';

import { Navigate } from '@tanstack/react-router';

import { useAuthStore } from '@/store/auth-store';

/**
 * Role-level guards for the admin route tree.
 *
 * These centralise the *route* gate so it can't drift from the sidebar nav.
 * Per TASK-327 ("scope, not visibility") any admin — SUPER_ADMIN /
 * GLOBAL_ADMIN / TENANT_ADMIN — may reach the full admin console; per-tenant
 * and per-permission scoping is enforced server-side (X-Tenant-Id + CASL),
 * and each page already renders a tenant-scoped view for non-super-admins.
 *
 * Previously every admin route re-implemented its own inline role check, which
 * drifted: Tenants / Departments / Prompts / Audio Pipelines were still gated
 * to SUPER_ADMIN only — so a TENANT_ADMIN saw those nav items but hit /403 —
 * and Prisma Studio had *no* guard at all (reachable by direct URL despite the
 * nav hiding it). Both predicates now come from the auth store so the nav and
 * the routes share one source of truth.
 */

/** Gate for every admin page (SUPER_ADMIN ∪ GLOBAL_ADMIN ∪ TENANT_ADMIN). */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  if (!isAdmin) {
    return <Navigate to="/403" />;
  }
  return <>{children}</>;
}

/**
 * Gate for global-scope-only surfaces (Prisma Studio — TASK-326 Q4).
 * SUPER_ADMIN ∪ GLOBAL_ADMIN only; a TENANT_ADMIN is redirected to /403.
 */
export function RequireGlobalScope({ children }: { children: ReactNode }) {
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  if (!isGlobalScope) {
    return <Navigate to="/403" />;
  }
  return <>{children}</>;
}
