import type { Metadata } from 'next';
import { WorkflowManagementScreen } from '@/features/workflow-studio/components/management';

export const metadata: Metadata = { title: 'Workflow Studio' };

/**
 * TASK-1036 OD-13 — `/workflow-studio` is the workflow MANAGEMENT list again (one row per slug),
 * reversing TASK-893 OD-1's redirect-into-the-studio. A row opens `/workflow-studio/[definitionId]`,
 * the canonical deep link into the studio; `/workflow-studio/new` is the create form (tier 30-49).
 */
export default function WorkflowStudioPage() {
  return <WorkflowManagementScreen />;
}
