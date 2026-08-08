import type { Metadata } from 'next';

import { BillingScreen } from '@/features/billing/components/billing-screen';

export const metadata: Metadata = { title: 'Billing & Invoices' };

export default function BillingPage() {
  return <BillingScreen />;
}
