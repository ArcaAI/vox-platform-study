import type { Metadata } from 'next';
import { MonitoringScreen } from '@/features/monitoring/components/monitoring-screen';
import { effectiveRoles, getSession, isElevated } from '@/server/session';

export const metadata: Metadata = {
  title: 'Monitoring',
};

/**
 * Frame 11 — Monitoring. Tier 20-29 (shared) since TASK-954: the gateway serves
 * `admin/monitoring/*` and `admin/health/services` to a tenant admin
 * (`read:TenantTelemetry`), so the console does too. Only the Redis health
 * read (`admin/queues/health/redis`) is `manage:all`; `platformOps` keeps that
 * card off a non-elevated screen rather than rendering a control that can
 * only 403.
 */
export default async function MonitoringPage() {
  const session = await getSession();
  const elevated = isElevated({ roles: [...effectiveRoles(session)] });
  return <MonitoringScreen platformOps={elevated} />;
}
