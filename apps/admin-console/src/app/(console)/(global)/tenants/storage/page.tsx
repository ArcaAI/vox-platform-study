import type { Metadata } from 'next';
import { TenantStorageScreen } from '@/features/storage/components/tenant-storage-screen';

export const metadata: Metadata = { title: 'Tenant Storage' };

/** Frame 14 — Tenant storage administration (tier 10-19). */
export default function TenantStoragePage() {
    return <TenantStorageScreen />;
}
