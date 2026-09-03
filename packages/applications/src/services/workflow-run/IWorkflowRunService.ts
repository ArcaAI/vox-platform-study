import { CursorPage } from '../../common/cursorPagination';
import { ApproveRunGateInput, RunGateStateResponse } from './dto';
import {
  GetRunTraceOptions,
  ListWorkflowRunsFilters,
  ListWorkflowRunsOptions,
  RecordRunFinishedInput,
  RecordRunStartedInput,
  RunTraceResponse,
  WorkflowRunResponse,
} from './dto';

/**
 * The runs/observability read model service — D6's "CQRS-lite ...
 * read models for runs/observability".
 */
export interface IWorkflowRunService {
  /**
   * Tenant-scoped, keyset-paginated, filterable runs list. `includeSandbox`
   * defaults to `false` — the single query-level filter point for
   * sandbox runs.
   */
  listRuns(tenantId: string, filters?: ListWorkflowRunsFilters, options?: ListWorkflowRunsOptions): Promise<CursorPage<WorkflowRunResponse>>;

  /** A single run. Cross-tenant id throws `NotFoundException` (404-over-403). */
  getRun(tenantId: string, runId: string): Promise<WorkflowRunResponse>;

  /**
   * The CQRS-lite read shape: the run row plus its per-node rollup, assembled
   * from ONE bounded trajectory read (no per-node query). Cross-tenant id
   * throws `NotFoundException`.
   */
  getRunTrace(tenantId: string, runId: string, options?: GetRunTraceOptions): Promise<RunTraceResponse>;

  /**
   * Idempotent on `(tenantId, sessionId, runId)`. The write contract
   * calls (currently unwired — see the ticket's R2). Emits NO sys-event
   * (telemetry exemption).
   */
  recordRunStarted(input: RecordRunStartedInput): Promise<WorkflowRunResponse>;

  /** Idempotent on `(tenantId, sessionId, runId)`. Emits NO sys-event. */
  recordRunFinished(input: RecordRunFinishedInput): Promise<WorkflowRunResponse>;

  /**
   * Live HITL-gate state for a run. Cross-tenant id throws
   * `NotFoundException` — the tenancy boundary is asserted against the run READ MODEL before
   * anything is asked of the harness.
   *
   * Read live from the gate child workflow rather than projected: `WorkflowRunStatus` has no
   * "waiting on a human" member, so a run parked at its gate and a run busy generating text are
   * both `RUNNING`, and a projection would become a second source of truth for a decision
   * boundary.
   */
  getRunGate(tenantId: string, runId: string): Promise<RunGateStateResponse>;

  /**
   * Release a run's HITL gate with a clinician decision.
   *
   * The recorded clinician is the ACTING user (CLS), never a value from the request — a caller
   * must not be able to name someone else as the signer. Cross-tenant id throws
   * `NotFoundException`; a run with no live gate throws `BadRequestException` rather than
   * reporting a sign-off that reached nothing.
   */
  approveRunGate(tenantId: string, runId: string, input: ApproveRunGateInput): Promise<RunGateStateResponse>;
}

export const IWorkflowRunService = Symbol('IWorkflowRunService');
