import type { Metadata } from 'next';
import { CheckpointsScreen } from '@/features/tenant-checkpoints/components/checkpoints-screen';

export const metadata: Metadata = { title: 'Checkpoints' };

/** Tenant checkpoints (tier 30-49, working-tenant scoped). */
export default function CheckpointsPage() {
  return <CheckpointsScreen />;
}
