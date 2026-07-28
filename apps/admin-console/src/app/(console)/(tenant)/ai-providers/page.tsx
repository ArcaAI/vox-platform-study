import type { Metadata } from 'next';
import { AiProvidersScreen } from '@/features/ai-providers/components/ai-providers-screen';

export const metadata: Metadata = { title: 'AI Providers' };

/**
 * ⚠️ DESIGN GATE OPEN (rule 12) — DO NOT MERGE TO NAV until an approved
 * Figma frame or recorded owner waiver exists (TASK-575).
 *
 * This route is built and tested but deliberately NOT linked from
 * `nav-config.ts`, and it does NOT redirect `/ai-configuration`,
 * `/stt-config`, or `/tts-config` — those three screens stay live and
 * unchanged. See
 * docs/implementation/TASK-575-Unified-AI-Providers-Console/README.md.
 */
export default function AiProvidersPage() {
  return <AiProvidersScreen />;
}
