import type { Metadata } from 'next';
import { AccountScreen } from '@/features/account/components/account-screen';

export const metadata: Metadata = { title: 'Account' };

/** Frame 25 (account half) — Account (tier 20-29, shared). */
export default function AccountPage() {
  return <AccountScreen />;
}
