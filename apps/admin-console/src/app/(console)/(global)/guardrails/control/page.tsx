import type { Metadata } from 'next';
import { GuardrailControlScreen } from '@/features/guardrail-control/components/guardrail-control-screen';

export const metadata: Metadata = { title: 'Guardrail control' };

/**
 * Guardrail control (tier 10-19, platform admin only — TASK-1050 §11.1): rules, judge prompts,
 * parameters and monitoring. The tenant admin's on/off screen is `/guardrails` (tier 30-49).
 */
export default function GuardrailControlPage() {
  return <GuardrailControlScreen />;
}
