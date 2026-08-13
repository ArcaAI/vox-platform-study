import type { Metadata } from 'next';
import { PromptTemplatesScreen } from '@/features/agents/components/prompt-templates-screen';

export const metadata: Metadata = { title: 'Prompt Instruction Templates' };

/**
 * Prompt Instruction Templates (tier 30-49) — tenant-admin
 * management of the prompts behind pre-summary and summary generation:
 * fallback resolution map, CRUD, version history, diff and clinical approval.
 */
export default function PromptTemplatesPage() {
  return <PromptTemplatesScreen />;
}
