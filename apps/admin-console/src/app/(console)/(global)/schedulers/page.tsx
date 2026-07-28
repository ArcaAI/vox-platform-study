import type { Metadata } from 'next';
import { SchedulersScreen } from '@/features/queues/components/schedulers-screen';

export const metadata: Metadata = {
  title: 'Schedulers',
};

export default function SchedulersPage() {
  return <SchedulersScreen />;
}
