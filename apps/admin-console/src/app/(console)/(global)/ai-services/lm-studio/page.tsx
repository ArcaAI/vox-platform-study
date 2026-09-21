import type { Metadata } from 'next';
import { EngineScreen } from '@/features/inference-engines/components/engine-screen';

export const metadata: Metadata = { title: 'LM Studio' };

/**
 * LM Studio — self-hosted GGUF engine state (tier 10-19, SUPER_ADMIN only).
 *
 * Read-only EXCEPT the Serving Control tab (TASK-996, owner decision D-1),
 * which loads, unloads and sets the per-model load-time serving profile. Every
 * other tab here still only reports engine state.
 */
export default function LmStudioPage() {
  return <EngineScreen provider="lm-studio" />;
}
