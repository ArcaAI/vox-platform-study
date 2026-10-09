import type { Metadata } from 'next';
import { ActionConfirmationsScreen } from '@/features/action-confirmations/components/action-confirmations-screen';

export const metadata: Metadata = {
  title: 'Action confirmations',
};

/**
 * Action confirmations (Platform Ops, tier 10-19, SUPER_ADMIN only).
 *
 * In the `(global)` route group, so the tier guard 404s a non-elevated session. The policy is
 * platform-wide (SYSTEM tier) — there is no tenant override.
 */
export default function ActionConfirmationsPage() {
  return <ActionConfirmationsScreen />;
}
