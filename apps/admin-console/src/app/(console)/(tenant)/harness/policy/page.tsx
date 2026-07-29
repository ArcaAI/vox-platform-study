import type { Metadata } from 'next';
import { HarnessPolicyScreen } from '@/features/harness-policy/components/harness-policy-screen';

export const metadata: Metadata = { title: 'Harness Policy & Live Config' };

/** Frame 36 — Harness policy & live config (tier 30-49, working tenant). */
export default function HarnessPolicyPage() {
  return <HarnessPolicyScreen />;
}
