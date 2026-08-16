import type { Metadata } from 'next';
import { DefinitionsListScreen } from '@/features/workflow-studio/components';

export const metadata: Metadata = { title: 'Workflow Studio' };

/** Frame `NN.4 - Workflow Studio — Definitions List` (tier 30-49). */
export default function WorkflowStudioPage() {
  return <DefinitionsListScreen />;
}
