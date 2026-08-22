import type { Metadata } from 'next';
import { SecurityPolicyScreen } from '@/features/security-policy/components/security-policy-screen';

export const metadata: Metadata = {
  title: 'Credential Policy',
};

/** Credential policy (tier 10-19, SUPER_ADMIN only) — password + issued-secret strength. */
export default function SecurityPolicyPage() {
  return <SecurityPolicyScreen />;
}
