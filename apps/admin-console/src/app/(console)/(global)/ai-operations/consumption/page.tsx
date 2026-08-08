import type { Metadata } from 'next';

import { ConsumptionCostScreen } from '@/features/consumption-cost/components/consumption-cost-screen';

export const metadata: Metadata = { title: 'AI Operations — Consumption & Cost' };

export default function ConsumptionCostPage() {
  return <ConsumptionCostScreen />;
}
