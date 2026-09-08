import type { Metadata } from 'next';
import { FeatureGateBoundary } from '@/shared/feature-gates/feature-gate-boundary';
import { WorkflowRunsScreen } from '@/features/workflow-runs/components/workflow-runs-screen';

export const metadata: Metadata = { title: 'Workflow Runs' };

/**
 * Frame N — Workflow Runs list (tier 30-49).
 *
 * TASK-932 §3.2: wrapped in `console.workflowHarness.enabled` — see
 * `harness/policy/page.tsx` for the domain-wide gate rationale.
 */
export default function WorkflowRunsPage() {
  return (
    <FeatureGateBoundary gate="console.workflowHarness.enabled">
      <WorkflowRunsScreen />
    </FeatureGateBoundary>
  );
}
