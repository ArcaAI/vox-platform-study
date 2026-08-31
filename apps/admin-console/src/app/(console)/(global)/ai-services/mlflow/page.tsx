import type { Metadata } from 'next';
import { MlflowScreen } from '@/features/mlflow/components/mlflow-screen';

export const metadata: Metadata = { title: 'MLflow' };

/**
 * MLflow — the model registry of record (tier 10-19, SUPER_ADMIN only).
 *
 * A NATIVE read-only surface over MLflow's REST verbs through the gateway, not
 * an iframe: MLflow frame-denies by default, authenticates nobody of its own,
 * and has no browser-reachable URL. The Access tab states all three and renders
 * the embed automatically once a deployment clears them.
 */
export default function MlflowPage() {
  return <MlflowScreen />;
}
