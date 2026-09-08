import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { effectiveRoles, getSession, isElevated } from '@/server/session';

/**
 * Tier 30–49 guard (rule 13): tenant-admin-scope screens render for
 * TENANT_ADMIN and for the elevated cross-tenant set (who additionally need a
 * working tenant — enforced per screen by <WorkingTenantGate>, because
 * /consultations renders a cross-tenant aggregate instead of the gate).
 * Everyone else 404s — never 403 — matching the gateway's existence-hiding
 * posture.
 */
export default async function TenantTierLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  // Effective identity: the impersonated target while impersonating (TASK-932).
  const roles = effectiveRoles(session);
  if (!isElevated({ roles: [...roles] }) && !roles.includes('TENANT_ADMIN')) {
    notFound();
  }
  return children;
}
