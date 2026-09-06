import type { Metadata } from 'next';
import { EngineScreen } from '@/features/inference-engines/components/engine-screen';

export const metadata: Metadata = { title: 'llama.cpp' };

/**
 * llama.cpp — the single-model, low-overhead self-hosted tier (tier 10-19,
 * SUPER_ADMIN only).
 *
 * A SIBLING ROUTE to the other engine screens (see `ollama/page.tsx` for why
 * each engine gets its own route rather than a `?engine=` filter). Its one
 * behavioural difference — the server serves exactly what it lists, so "listed"
 * IS "ready" — lives in `engine-meta.ts` and in the readiness sweep, not in a
 * conditional here.
 */
export default function LlamaCppPage() {
  return <EngineScreen provider="llama-cpp" />;
}
