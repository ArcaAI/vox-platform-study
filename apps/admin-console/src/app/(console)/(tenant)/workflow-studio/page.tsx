import type { Metadata } from 'next';
import { WorkflowStudioScreen } from '@/features/workflow-studio/components';

export const metadata: Metadata = { title: 'Workflow Studio' };

/**
 * TASK-893 OD-1 — the definitions GRID is deleted; this route IS the studio. With no id in the
 * URL the screen resolves the tenant's most workable definition and replaces the URL with its
 * canonical deep link `/workflow-studio/[definitionId]`, so a shared link always names a
 * workflow (tier 30-49).
 */
export default function WorkflowStudioPage() {
  return <WorkflowStudioScreen />;
}
