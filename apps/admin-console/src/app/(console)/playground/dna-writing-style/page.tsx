import type { Metadata } from 'next';
import { MyDnaStyleScreen } from '@/features/playground-dna-style/components/my-dna-style-screen';

export const metadata: Metadata = { title: 'My DNA Writing Style' };

/** Frame 53 — my DNA writing style (playground tier 50-59, matrix row 37). */
export default function PlaygroundDnaWritingStylePage() {
  return <MyDnaStyleScreen />;
}
