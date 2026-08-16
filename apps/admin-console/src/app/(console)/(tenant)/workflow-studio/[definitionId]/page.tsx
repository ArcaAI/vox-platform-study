import type { Metadata } from 'next';
import { WorkflowStudioScreen } from '@/features/workflow-studio/components';

export const metadata: Metadata = { title: 'Workflow Studio' };

/** Frames `NN`/`NN.1`/`NN.2`/`NN.3` (canvas, list, inspector, validation — tier 30-49). Route
 *  param doubles as the "new definition" entry point (`definitionId === 'new'`). */
export default async function WorkflowStudioDefinitionPage({ params }: { params: Promise<{ definitionId: string }> }) {
  const { definitionId } = await params;
  return <WorkflowStudioScreen definitionId={definitionId} />;
}
