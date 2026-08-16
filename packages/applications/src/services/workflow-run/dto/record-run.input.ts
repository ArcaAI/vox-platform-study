/**
 * The write contract TASK-718's dispatcher (or a future gateway controller)
 * calls at `POST /workflow-runs:start` time — see the ticket's R2 and the
 * Task 1 contract §7 for the current wiring gap (nothing calls this yet).
 */
export interface RecordRunStartedInput {
  tenantId: string;
  workflowVersionId: string;
  workflowSlug: string;
  workflowVersionNumber: number;
  definitionName: string;
  /** The derived join key — "workflow-interpreter-{runId}" (Task 1 contract §2). */
  sessionId: string;
  runId: string;
  trigger: string;
  isSandbox?: boolean;
  startedAt?: Date;
}

/** Called when the interpreter's run reaches a terminal state. */
export interface RecordRunFinishedInput {
  tenantId: string;
  sessionId: string;
  runId: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';
  endedAt?: Date;
  nodeCount?: number;
  failedNodeCount?: number;
  degradedNodeCount?: number;
  firstErrorCode?: string | null;
}
