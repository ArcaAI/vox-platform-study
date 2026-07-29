import type { Metadata } from 'next';
import { ConsultationsScreen } from '@/features/consultations/components/consultations-screen';

export const metadata: Metadata = { title: 'Consultations' };

/**
 * Frame 40 — Consultations (tier 30-49, matrix row 33). No WorkingTenantGate
 * here by design: an elevated session without a working tenant renders the
 * cross-tenant aggregate view (the documented row 33 exception).
 */
export default function ConsultationsPage() {
  return <ConsultationsScreen />;
}
