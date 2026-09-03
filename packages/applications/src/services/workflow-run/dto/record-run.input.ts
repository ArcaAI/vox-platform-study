/**
 * The write contract dispatcher (or a future gateway controller)
 * calls at `POST /workflow-runs:start` time — see the ticket's R2 and the
 * Task 1 contract for the current wiring gap (nothing calls this yet).
 */
export interface RecordRunStartedInput {
  tenantId: string;
  workflowVersionId: string;
  workflowSlug: string;
  workflowVersionNumber: number;
  definitionName: string;
  /** The derived join key — "workflow-interpreter-{runId}" (Task 1 contract */
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
  /**
   * (M-2) — the run's delivered output, the `output.deliver` node's `output` object
   * stored VERBATIM. A discriminated union (`deliver.py`): `{ resultRef: ClaimCheckRef }` when
   * claim-check is enabled and the blob was offloaded, or `{ outputs: {...} }` inline otherwise.
   *
   * OMITTED (not null) means "this run delivered nothing" — a graph with no `output.deliver`
   * node, or a caller that does not report it — and leaves any existing value alone. An explicit
   * `null` clears it.
   */
  resultRef?: Record<string, unknown> | null;
}
