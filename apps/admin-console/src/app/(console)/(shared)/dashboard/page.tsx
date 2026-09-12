import type { Metadata } from 'next';
import { PlatformDashboard } from '@/features/platform/components/platform-dashboard';
import { TenantDashboard } from '@/features/platform/components/tenant-dashboard';
import { effectiveRoles, getSession, isElevated } from '@/server/session';

export const metadata: Metadata = {
  title: 'Dashboard',
};

/**
 * `/dashboard` — tier 20-29 (shared) since TASK-954.
 *
 * ONE route, two audiences, decided on the server from the EFFECTIVE identity
 * (the impersonated target while impersonating — the same identity the tier
 * guards judge): an elevated session gets the cross-tenant Platform Dashboard
 * (frame 10, unchanged); everyone else gets the Tenant Dashboard — its own
 * usage, the services it depends on, and its own recent admin activity. Decided
 * here rather than client-side so a tenant admin never sees a frame of platform
 * metrics that then 403 and swap out.
 */
export default async function DashboardPage() {
  const session = await getSession();
  const elevated = isElevated({ roles: [...effectiveRoles(session)] });
  return elevated ? <PlatformDashboard /> : <TenantDashboard />;
}
