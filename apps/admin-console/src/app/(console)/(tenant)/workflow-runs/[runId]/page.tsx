import type { Metadata } from 'next';
import { FeatureGateBoundary } from '@/shared/feature-gates/feature-gate-boundary';
import { RunTraceScreen } from '@/features/workflow-runs/components/run-trace-screen';

export const metadata: Metadata = { title: 'Run trace' };

/**
 * Frame N.1 — Run trace (canvas overlay), tier 30-49.
 *
 * TASK-932 §3.2: wrapped in `console.workflowHarness.enabled` — a run trace
 * is a `/workflow-runs*` sub-route, so it shares the domain-wide gate (see
 * `harness/policy/page.tsx`).
 */
export default async function RunTracePage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <FeatureGateBoundary gate="console.workflowHarness.enabled">
      <RunTraceScreen runId={runId} />
    </FeatureGateBoundary>
  );
}
