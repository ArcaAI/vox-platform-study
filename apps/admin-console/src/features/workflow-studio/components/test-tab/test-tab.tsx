'use client';

/**
 * Workflow Studio — Test tab (TASK-1036 §10.2). Placeholder mounted by the studio shell (lane C2a);
 * lane C3 replaces the body with the run surface (flow, step panel, controls, execution context,
 * events, status bar). Keep the props contract stable: the shell passes the definition being tested.
 */
export interface TestTabProps {
  definitionId: string;
}

export function TestTab({ definitionId }: TestTabProps) {
  return <div data-slot="workflow-test-tab" data-definition-id={definitionId} />;
}
