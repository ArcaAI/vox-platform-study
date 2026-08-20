import type { Metadata } from 'next';
import { AssignmentMatrixScreen } from '@/features/workflow-studio/components';

export const metadata: Metadata = { title: 'Workflow Assignments' };

/** TASK-733 half (a) Task 6 — the department/tenant × palette assignment matrix (tier 30-49). */
export default function WorkflowAssignmentsPage() {
  return <AssignmentMatrixScreen />;
}
