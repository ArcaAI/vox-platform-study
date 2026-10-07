import type { Metadata } from 'next';
import { GuardrailRulesScreen } from '@/features/guardrail-rules/components/guardrail-rules-screen';

export const metadata: Metadata = { title: 'Guardrail rules' };

/** Tenant guardrail rules (tier 30-49, working-tenant scoped). */
export default function GuardrailsPage() {
  return <GuardrailRulesScreen />;
}
