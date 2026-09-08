import type { Metadata } from 'next';
import { FeatureGateBoundary } from '@/shared/feature-gates/feature-gate-boundary';
import { AgenticPolicyScreen } from '@/features/agentic-policy/components/agentic-policy-screen';

export const metadata: Metadata = { title: 'Agentic Policy' };

/**
 * screen 3 — global-default agentic loop policy (tier 10-19, SUPER_ADMIN only).
 *
 * TASK-932 §3.2: wrapped in `console.agenticPolicy.enabled` — a platform-wide
 * visibility gate (rule 13 §Routing), on top of the unchanged SUPER_ADMIN gate.
 */
export default function AgenticPolicyPage() {
  return (
    <FeatureGateBoundary gate="console.agenticPolicy.enabled">
      <AgenticPolicyScreen />
    </FeatureGateBoundary>
  );
}
