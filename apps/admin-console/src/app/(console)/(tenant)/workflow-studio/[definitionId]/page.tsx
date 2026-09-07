import type { Metadata } from 'next';
import { WorkflowStudioScreen } from '@/features/workflow-studio/components';

export const metadata: Metadata = { title: 'Workflow Studio' };

/** The canonical deep link into the studio (canvas · inspector · sandbox — tier 30-49). The route
 *  param doubles as the "new definition" entry point (`definitionId === 'new'`). TASK-893 OD-1
 *  deleted the list view and the definitions grid, so this is the studio's only addressable state. */
export default async function WorkflowStudioDefinitionPage({ params }: { params: Promise<{ definitionId: string }> }) {
  const { definitionId } = await params;
  return <WorkflowStudioScreen definitionId={definitionId} />;
}
