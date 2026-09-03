/**
 * Filters + keyset options for `WorkflowRunService.listRuns`.
 * Plain internal contracts — the class-validator DTO lives at the apps/api
 * controller boundary (rule 04).
 */
export interface ListWorkflowRunsFilters {
  workflowSlug?: string;
  workflowVersionId?: string;
  status?: string;
  trigger?: string;
  /** Inclusive lower bound on `startedAt` (ISO-8601 instant). */
  from?: string;
  /** Inclusive upper bound on `startedAt` (ISO-8601 instant). */
  to?: string;
  /**
   * Sandbox runs ( Workbench) are excluded by default — the single
   * query-level filter point (Task 1 contract). Explicitly `true` to
   * include them.
   */
  includeSandbox?: boolean;
}

export interface ListWorkflowRunsOptions {
  /** Opaque keyset cursor (base64url) from a prior page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

/** Bounds for `WorkflowRunService.getRunTrace`'s single trajectory read (R8). */
export interface GetRunTraceOptions {
  /** Hard cap on trajectory steps folded into the rollup. Defaults to MAX_CURSOR_LIMIT. */
  maxSteps?: number;
}
