import type { Metadata } from 'next';
import { TenantProfileScreen } from '@/features/account/components/tenant-profile-screen';

export const metadata: Metadata = { title: 'Tenant Profile' };

/** Frame 25 (tenant half) — Tenant profile (tier 20-29, shared). */
export default function TenantProfilePage() {
    return <TenantProfileScreen />;
}
