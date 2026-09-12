import type { Metadata } from 'next';
import { ReleasesScreen } from '@/features/releases/components/releases-screen';

export const metadata: Metadata = {
  title: 'Releases',
};

/**
 * Platform Releases — tier 20-29 (shared) since TASK-954: the release registry
 * carries the same gate as `/admin/health/services` (`manage:all` OR
 * `read:TenantTelemetry`), so a tenant admin reads it too. Platform-wide data,
 * no tenant rows to scope.
 */
export default function ReleasesPage() {
  return <ReleasesScreen />;
}
