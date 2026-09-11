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
  /**
   * TASK-950 (decision 2, fast win) — non-PHI bookkeeping stored VERBATIM in the row's
   * `_metadata` JSONB. The exposure plane uses it for `{ actingUserId }` on a STANDALONE machine
   * run: the clinician the run acts FOR, recorded BESIDE the service account the audit envelope
   * already names, never instead of it.
   *
   * OMITTED (not `{}`) means "this caller has nothing to record" — which is the honest answer for
   * a human caller, for a consultation-bound run (its identity is `Consultation.doctorId`), and
   * for a schema that declares no identity field alike.
   *
   * Write-only through this input, today: the value is queryable in SQL
   * (`_metadata->>'actingUserId'`) but `WorkflowRunEntity` carries no `metaData` accessor, so it
   * cannot be read back through the entity — see `WorkflowRunService.recordRunStarted`.
   */
  metaData?: Record<string, unknown>;
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
  /** TASK-864 — why the run ended (`cancelled_by_caller`, the interpreter's run status, …). PHI-free. */
  terminalReason?: string | null;
  /** TASK-864 — the consultation the run was bound to, when it was. An id, never content. */
  consultationId?: string | null;
}
