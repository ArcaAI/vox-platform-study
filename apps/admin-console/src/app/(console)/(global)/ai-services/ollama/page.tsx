import type { Metadata } from 'next';
import { EngineScreen } from '@/features/inference-engines/components/engine-screen';

export const metadata: Metadata = { title: 'Ollama' };

/**
 * Ollama — the pull-and-run self-hosted tier (tier 10-19, SUPER_ADMIN only).
 *
 * A SIBLING ROUTE to the other engine screens, sharing one component because
 * every region is fed by identical reads. Ollama was probed by the platform
 * (`admin/ai-models/discovery`, and now the readiness sweep) long before it had
 * a screen, so a down engine was visible only as a missing row somewhere else —
 * the rail is the engine inventory, and an engine absent from it is a blind
 * spot. Per-engine differences are data:
 * `features/inference-engines/components/engine-meta.ts`.
 */
export default function OllamaPage() {
  return <EngineScreen provider="ollama" />;
}
