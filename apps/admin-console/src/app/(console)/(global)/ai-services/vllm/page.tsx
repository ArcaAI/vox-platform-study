import type { Metadata } from 'next';
import { EngineScreen } from '@/features/inference-engines/components/engine-screen';

export const metadata: Metadata = { title: 'vLLM' };

/**
 * vLLM — the priority-1 self-hosted serving tier (tier 10-19, SUPER_ADMIN only).
 *
 * A SIBLING ROUTE to `/ai-services/lm-studio` rather than a variant of it: the
 * two share one screen component because every region is fed by identical reads,
 * but each engine's status is a distinct thing to link to, and the nav rail is
 * the platform's engine inventory. Per-engine differences are data —
 * `features/inference-engines/components/engine-meta.ts` carries the reasoning.
 */
export default function VllmPage() {
  return <EngineScreen provider="vllm" />;
}
