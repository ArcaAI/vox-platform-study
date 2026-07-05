import type { Metadata } from 'next';
import { DnaWritingStylesScreen } from '@/features/dna-writing-styles/components/dna-writing-styles-screen';

export const metadata: Metadata = { title: 'DNA Writing Styles' };

/** Frame 33 — DNA writing styles administration (tier 30-49). */
export default function DnaWritingStylesPage() {
    return <DnaWritingStylesScreen />;
}
