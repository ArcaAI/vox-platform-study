import type { Metadata } from 'next';
import { ConsentScreen } from '@/features/consent/components/consent-screen';

export const metadata: Metadata = { title: 'Patient Consent' };

/** Consent register (tier 30-49 — tenant-scoped, super admin via the (tenant) layout guard). */
export default function ConsentPage() {
  return <ConsentScreen />;
}
