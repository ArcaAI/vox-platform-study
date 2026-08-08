import type { Metadata } from 'next';

import { ReconciliationScreen } from '@/features/reconciliation/components/reconciliation-screen';

export const metadata: Metadata = { title: 'AI Operations — Provider Reconciliation' };

export default function ReconciliationPage() {
  return <ReconciliationScreen />;
}
