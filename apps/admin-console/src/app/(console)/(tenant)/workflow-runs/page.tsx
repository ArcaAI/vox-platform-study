import type { Metadata } from 'next';
import { WorkflowRunsScreen } from '@/features/workflow-runs/components/workflow-runs-screen';

export const metadata: Metadata = { title: 'Workflow Runs' };

/** Frame N — Workflow Runs list (tier 30-49). */
export default function WorkflowRunsPage() {
  return <WorkflowRunsScreen />;
}
