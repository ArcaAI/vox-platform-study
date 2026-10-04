'use client';

/**
 * Workflow Studio — Integration tab (TASK-1036 §3.6). Placeholder mounted by the studio shell (lane
 * C2a); lane C4 replaces the body with the step-by-step vox-node / vox / raw API guides driven by the
 * workflow settings and Input/Output shapes. Keep the props contract stable.
 */
export interface IntegrationTabProps {
  definitionId: string;
}

export function IntegrationTab({ definitionId }: IntegrationTabProps) {
  return <div data-slot="workflow-integration-tab" data-definition-id={definitionId} />;
}
