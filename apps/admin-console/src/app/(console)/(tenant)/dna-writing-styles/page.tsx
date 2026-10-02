import type { Metadata } from 'next';
import { DnaWritingStylesScreen } from '@/features/dna-writing-styles/components/dna-writing-styles-screen';

export const metadata: Metadata = { title: 'DNA Writing Style Memory' };

/** Frame 33 — DNA writing style memory (reports, memory, ingest, schedule) (tier 30-49). */
export default function DnaWritingStylesPage() {
  return <DnaWritingStylesScreen />;
}
