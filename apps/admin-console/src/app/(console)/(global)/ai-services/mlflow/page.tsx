import type { Metadata } from 'next';
import { FeatureGateBoundary } from '@/shared/feature-gates/feature-gate-boundary';
import { MlflowScreen } from '@/features/mlflow/components/mlflow-screen';

export const metadata: Metadata = { title: 'MLflow' };

/**
 * MLflow — the model registry of record (tier 10-19, SUPER_ADMIN only).
 *
 * A NATIVE read-only surface over MLflow's REST verbs through the gateway, not
 * an iframe: MLflow frame-denies by default, authenticates nobody of its own,
 * and has no browser-reachable URL. The Access tab states all three and renders
 * the embed automatically once a deployment clears them.
 *
 * TASK-932 §3.2: wrapped in `console.mlflow.enabled` — a platform-wide
 * visibility gate (rule 13 §Routing), on top of the unchanged SUPER_ADMIN gate.
 */
export default function MlflowPage() {
  return (
    <FeatureGateBoundary gate="console.mlflow.enabled">
      <MlflowScreen />
    </FeatureGateBoundary>
  );
}
