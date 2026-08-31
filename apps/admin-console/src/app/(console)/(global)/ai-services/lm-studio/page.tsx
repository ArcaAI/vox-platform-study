import type { Metadata } from 'next';
import { EngineScreen } from '@/features/inference-engines/components/engine-screen';

export const metadata: Metadata = { title: 'LM Studio' };

/**
 * LM Studio — self-hosted GGUF engine state (tier 10-19, SUPER_ADMIN only).
 * READ-ONLY: the console reports engine state and never mutates the workload.
 */
export default function LmStudioPage() {
  return <EngineScreen provider="lm-studio" />;
}
