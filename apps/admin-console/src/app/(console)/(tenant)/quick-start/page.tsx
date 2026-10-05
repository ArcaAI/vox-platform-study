import type { Metadata } from 'next';
import { QuickStartScreen } from '@/features/quick-start/components/quick-start-screen';

export const metadata: Metadata = { title: 'Quick start' };

/** Quick start — context schema → agent → workflow → assignment in one pass (tier 30-49). */
export default function QuickStartPage() {
  return <QuickStartScreen />;
}
