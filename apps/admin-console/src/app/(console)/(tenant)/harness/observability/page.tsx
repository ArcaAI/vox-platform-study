import type { Metadata } from 'next';
import { FeatureGateBoundary } from '@/shared/feature-gates/feature-gate-boundary';
import { HarnessObservabilityScreen } from '@/features/harness-ops/components/harness-observability-screen';

export const metadata: Metadata = { title: 'Harness Observability' };

/**
 * Frame 37 — Harness observability (tier 30-49).
 *
 * TASK-932 §3.2: wrapped in `console.workflowHarness.enabled` — see
 * `harness/policy/page.tsx` for the domain-wide gate rationale.
 */
export default function HarnessObservabilityPage() {
  return (
    <FeatureGateBoundary gate="console.workflowHarness.enabled">
      <HarnessObservabilityScreen />
    </FeatureGateBoundary>
  );
}
