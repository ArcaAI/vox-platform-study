import type { Metadata } from 'next';
import { AllowedOriginsScreen } from '@/features/allowed-origins/components/allowed-origins-screen';

export const metadata: Metadata = { title: 'Allowed Origins' };

/** CORS allow-list (tier 10-19, GLOBAL_ADMIN only via the (global) layout guard). */
export default function AllowedOriginsPage() {
  return <AllowedOriginsScreen />;
}
