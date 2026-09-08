import type { Metadata } from 'next';
import { FeatureMatrixScreen } from '@/features/feature-availability/components/feature-matrix-screen';

export const metadata: Metadata = {
  title: 'Feature Availability',
};

/**
 * Feature availability (Platform Ops, tier 10-19, SUPER_ADMIN only).
 *
 * In the `(global)` route group, so the tier guard 404s a non-elevated session
 * before the screen renders — matching the gateway's own posture on
 * `GET/PUT admin/settings/features/matrix`, which is super-admin-only.
 */
export default function FeatureAvailabilityPage() {
  return <FeatureMatrixScreen />;
}
