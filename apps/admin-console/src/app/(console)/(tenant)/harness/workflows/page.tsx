import type { Metadata } from 'next';
import { FeatureGateBoundary } from '@/shared/feature-gates/feature-gate-boundary';
import { HarnessWorkflowsScreen } from '@/features/harness-ops/components/harness-workflows-screen';

export const metadata: Metadata = { title: 'Harness Workflows' };

/**
 * Frame 38 — Harness workflows (tier 30-49).
 *
 * TASK-932 §3.2: wrapped in `console.workflowHarness.enabled` — see
 * `harness/policy/page.tsx` for the domain-wide gate rationale.
 */
export default function HarnessWorkflowsPage() {
  return (
    <FeatureGateBoundary gate="console.workflowHarness.enabled">
      <HarnessWorkflowsScreen />
    </FeatureGateBoundary>
  );
}
