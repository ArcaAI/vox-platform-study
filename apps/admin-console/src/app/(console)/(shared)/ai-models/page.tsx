import type { Metadata } from 'next';
import { AiModelsScreen } from '@/features/ai-models/components/ai-models-screen';

export const metadata: Metadata = {
  title: 'AI Model Registry',
};

/** Frame 15 — AI Model Registry (tier 20-29: every admin reads it, only a platform admin manages it). */
export default function AiModelsPage() {
  return <AiModelsScreen />;
}
