import { CursorPage } from '../../common/cursorPagination';
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
 * The runs/observability read model service (TASK-723) — D6's "CQRS-lite ...
 * read models for runs/observability".
 */
export interface IWorkflowRunService {
  /**
   * Tenant-scoped, keyset-paginated, filterable runs list. `includeSandbox`
   * defaults to `false` — the single query-level filter point for TASK-721's
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
   * Idempotent on `(tenantId, sessionId, runId)`. The write contract TASK-718
   * calls (currently unwired — see the ticket's R2). Emits NO sys-event
   * (telemetry exemption).
   */
  recordRunStarted(input: RecordRunStartedInput): Promise<WorkflowRunResponse>;

  /** Idempotent on `(tenantId, sessionId, runId)`. Emits NO sys-event. */
  recordRunFinished(input: RecordRunFinishedInput): Promise<WorkflowRunResponse>;
}

export const IWorkflowRunService = Symbol('IWorkflowRunService');
