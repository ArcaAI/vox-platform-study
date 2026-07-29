import type { Metadata } from 'next';
import { StorageBrowserScreen } from '@/features/storage-browser/components/storage-browser-screen';

export const metadata: Metadata = { title: 'Storage' };

/** Frame 31 — tenant Storage browser (tier 30-49 data plane). */
export default function StorageBrowserPage() {
  return <StorageBrowserScreen />;
}
