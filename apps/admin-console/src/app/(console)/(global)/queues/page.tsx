import type { Metadata } from 'next';
import { QueuesScreen } from '@/features/queues/components/queues-screen';

export const metadata: Metadata = {
    title: 'Queues & Jobs',
};

export default function QueuesPage() {
    return <QueuesScreen />;
}
