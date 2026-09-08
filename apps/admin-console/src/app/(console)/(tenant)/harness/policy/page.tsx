import type { Metadata } from 'next';
import { FeatureGateBoundary } from '@/shared/feature-gates/feature-gate-boundary';
import { HarnessPolicyScreen } from '@/features/harness-policy/components/harness-policy-screen';

export const metadata: Metadata = { title: 'Harness Policy & Live Config' };

/**
 * Frame 36 — Harness policy & live config (tier 30-49, working tenant).
 *
 * TASK-932 §3.2: wrapped in `console.workflowHarness.enabled` — the whole
 * Workflow & Harness domain shares this one platform-wide visibility gate
 * (rule 13 §Routing), on top of the unchanged ability gate.
 */
export default function HarnessPolicyPage() {
  return (
    <FeatureGateBoundary gate="console.workflowHarness.enabled">
      <HarnessPolicyScreen />
    </FeatureGateBoundary>
  );
}
