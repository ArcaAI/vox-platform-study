import type { Metadata } from 'next';
import { SettingsRegistryScreen } from '@/features/settings-registry/components/settings-registry-screen';

export const metadata: Metadata = { title: 'Settings Registry' };

/**
 * The descriptor-driven settings registry (tier 20-29 shared).
 *
 * Tier 20-29 because the catalog route is RBAC-filtered rather than
 * super-admin-only: a tenant admin sees the keys they may edit and does not see
 * `globalOnly` entries at all. Which SCOPE a write lands at is a separate,
 * orthogonal gate enforced in the drawer and by the gateway.
 */
export default function SettingsRegistryPage() {
  return <SettingsRegistryScreen />;
}
