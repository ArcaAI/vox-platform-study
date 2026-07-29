import type { Metadata } from 'next';
import { TenantsListScreen } from '@/features/tenants/components/tenants-list-screen';

export const metadata: Metadata = { title: 'Tenants' };

/** Frame 12 — Tenants list (tier 10-19). */
export default function TenantsPage() {
  return <TenantsListScreen />;
}
