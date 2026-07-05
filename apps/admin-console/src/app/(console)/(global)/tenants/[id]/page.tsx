import type { Metadata } from 'next';
import { TenantDetailScreen } from '@/features/tenants/components/tenant-detail-screen';

export const metadata: Metadata = { title: 'Tenant detail' };

/** Frame 12.1 — Tenant detail (tier 10-19). */
export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <TenantDetailScreen id={id} />;
}
