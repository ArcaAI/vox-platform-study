import type { Metadata } from 'next';
import { EntitlementsScreen } from '@/features/entitlements/components/entitlements-screen';

export const metadata: Metadata = { title: 'Entitlements & Plans' };

/** Frame 13 — Entitlements & plans (tier 10-19). */
export default function EntitlementsPage() {
    return <EntitlementsScreen />;
}
