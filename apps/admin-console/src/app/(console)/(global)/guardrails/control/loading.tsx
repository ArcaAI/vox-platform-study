import { GuardrailControlSkeleton } from '@/features/guardrail-control/components/guardrail-control-screen';

/** Route-level loading state (rule 10): header, tab strip and body placeholders. */
export default function GuardrailControlLoading() {
  return <GuardrailControlSkeleton />;
}
