/**
 * Frame 38 shows a Type column (doc/eval/live) but the workflow DTO carries no
 * type field and the list endpoint no type param — the kind is derived
 * client-side from the workflow-id scheme (`harness-doc-{consultationId}`).
 */
export type WorkflowKind = 'doc' | 'eval' | 'live' | 'other';

export function workflowKind(workflowId: string): WorkflowKind {
  const id = workflowId.toLowerCase();
  if (id.includes('doc')) return 'doc';
  if (id.includes('eval')) return 'eval';
  if (id.includes('live')) return 'live';
  return 'other';
}

export const WORKFLOW_KINDS: WorkflowKind[] = ['doc', 'eval', 'live', 'other'];
