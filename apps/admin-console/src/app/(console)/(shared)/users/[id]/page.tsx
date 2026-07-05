import type { Metadata } from 'next';
import { UserDetailScreen } from '@/features/users/components/user-detail-screen';

export const metadata: Metadata = { title: 'User detail' };

/** Frame 20.1 — User detail (tier 20-29, shared). */
export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <UserDetailScreen id={id} />;
}
