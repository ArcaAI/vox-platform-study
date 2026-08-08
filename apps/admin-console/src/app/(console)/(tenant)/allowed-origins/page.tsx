import type { Metadata } from 'next';
import { AllowedOriginsScreen } from '@/features/allowed-origins/components/allowed-origins-screen';

export const metadata: Metadata = { title: 'Allowed Origins' };

/** CORS allow-list (tier 30-49, TENANT_ADMIN for their own tenant + GLOBAL_ADMIN via the (tenant) layout guard). */
export default function AllowedOriginsPage() {
  return <AllowedOriginsScreen />;
}
