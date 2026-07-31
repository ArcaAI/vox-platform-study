import type { Metadata } from 'next';
import { AiProvidersScreen } from '@/features/ai-providers/components/ai-providers-screen';

export const metadata: Metadata = { title: 'AI Providers' };

/**
 * Unified "AI Providers" screen (TASK-575), wired into nav under
 * TASK-586 Lane J — the rule-12 design gate was waived by the owner.
 *
 * This route does NOT redirect `/ai-configuration`, `/stt-config`, or
 * `/tts-config` — those three screens stay live and unchanged. See
 * docs/implementation/TASK-575-Unified-AI-Providers-Console/README.md.
 */
export default function AiProvidersPage() {
  return <AiProvidersScreen />;
}
