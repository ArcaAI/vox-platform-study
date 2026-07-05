import type { Metadata } from 'next';
import { QueueDetailScreen } from '@/features/queues/components/queue-detail-screen';

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
    const { name } = await params;
    return { title: decodeURIComponent(name) };
}

export default async function QueueDetailPage({ params }: { params: Promise<{ name: string }> }) {
    const { name } = await params;
    return <QueueDetailScreen name={decodeURIComponent(name)} />;
}
