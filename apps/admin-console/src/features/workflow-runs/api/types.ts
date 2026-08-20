/**
 * Wire types for the tenant-scoped Workflow Runs surface (TASK-723, Phase C).
 * Shapes mirror the gateway DTOs in @arcaai/applications
 * (`WorkflowRunResponse` / `RunTraceResponse` / `RunNodeRollupResponse`) and
 * `@arcaai/workflow-contract`'s `WorkflowGraph` (`WorkflowDefinitionResponse.graph`).
 * The console cannot import either server package, so they are re-declared
 * here — the same convention `features/ai-operations-runs/api/types.ts`
 * documents ("features never import one another", rule 13).
 */

export type WorkflowRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT' | string;

/** GET /admin/workflow-runs and :runId row (WorkflowRunResponse). */
export interface WorkflowRun {
  id: string;
  tenantId: string;
  /** WorkflowDefinition.id of the exact PUBLISHED, immutable version pinned for this run. */
  workflowVersionId: string;
  /** WorkflowDefinition.slug — the stable lineage key across versions. */
  workflowSlug: string;
  workflowVersionNumber: number;
  /** Denormalized WorkflowDefinition.name at run time (README R7: may be stale vs. a later rename). */
  definitionName: string;
  /** The AgentTrajectoryStep join key ("workflow-interpreter-{runId}"). */
  sessionId: string;
  /** The domain run id (empty-string sentinel convention). */
  runId: string;
  /** consultation open | api invoke | webhook | schedule. */
  trigger: string;
  status: WorkflowRunStatus;
  isSandbox: boolean;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  nodeCount: number | null;
  failedNodeCount: number;
  /** Count of nodes that degraded (produced a marked nothing) — a flag, never a run status. */
  degradedNodeCount: number;
  firstErrorCode: string | null;
  createdAt: string;
}

/** Keyset page envelope — matches `@/shared/api`'s `CursorPaginated<T>` exactly. */
export interface WorkflowRunsPage {
  data: WorkflowRun[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface ListWorkflowRunsParams {
  workflowSlug?: string;
  workflowVersionId?: string;
  status?: string;
  trigger?: string;
  /** Inclusive lower bound on `startedAt` (ISO-8601 instant). */
  from?: string;
  /** Inclusive upper bound on `startedAt` (ISO-8601 instant). */
  to?: string;
  /** TASK-721 Workbench sandbox runs — excluded unless explicitly true. */
  includeSandbox?: boolean;
  cursor?: string;
  limit?: number;
  [key: string]: string | number | boolean | undefined | null;
}

export type TrajectoryStepStatus = 'STARTED' | 'OK' | 'ERROR' | 'SKIPPED' | 'TIMEOUT' | string;

/**
 * One node-execution rollup within a run's trace (RunNodeRollupResponse).
 * `nodeType` is the trajectory step's `name` — NOT a per-node id (the
 * interpreter never stamps one onto the persisted row); `order` is the
 * closest thing to node identity this rollup offers. `attemptGroupingIsDerived`
 * is always `true` today — render the grouping as derived, never authoritative.
 */
export interface RunNodeRollup {
  nodeType: string;
  order: number;
  status: TrajectoryStepStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  attemptSeqs: number[];
  attemptCount: number;
  attemptGroupingIsDerived: boolean;
}

/** GET /admin/workflow-runs/:runId/trace (RunTraceResponse). */
export interface RunTrace {
  run: WorkflowRun;
  nodes: RunNodeRollup[];
  stepCount: number;
  /** True when the bounded trajectory read hit its cap — the rollup is a prefix, not the whole run. */
  truncated: boolean;
  /** True when the run has zero steps and predates the effective trace-retention window (Task 9). */
  tracePruned: boolean;
}

/** One node authored on a `WorkflowDefinition.graph` (`WorkflowGraphNode`). `position` is
 *  optional — a graph saved before the Studio persisted layout, or one authored entirely
 *  through the list/tree editor, may still carry none; see `lib/graph-layout.ts`. */
export interface WorkflowGraphNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
}

/** One edge authored on a `WorkflowDefinition.graph` (`WorkflowGraphEdge`). */
export interface WorkflowGraphEdge {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

/** The authored graph document (`WorkflowGraph`), exactly as `WorkflowDefinitionResponse.graph` carries it. */
export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

/**
 * A read-only slice of `WorkflowDefinitionResponse` (`@arcaai/applications`) —
 * only the fields the pinned-version deep link needs (Task 8). Re-declared
 * for the same cross-feature reason as the rest of this file.
 */
export interface WorkflowDefinitionSlice {
  id: string;
  slug: string;
  name: string;
  versionNumber: number;
  status: string;
  graph: Record<string, unknown>;
}

/**
 * Live HITL-gate state for a run (TASK-731 Phase B), mirrored off
 * `RunGateStateResponse` (`packages/applications/.../dto/run-gate.ts`).
 *
 * `waiting` is the ONLY field an Approve affordance may key off. `exists: false` is the normal
 * answer for every run without a gate — a 200, never an error.
 */
export interface RunGateState {
  runId: string;
  exists: boolean;
  waiting: boolean;
  phase?: string;
  escalations?: number;
  approved?: boolean;
}

/** Body for the approve call. There is deliberately NO clinician field — the signer is the
 *  acting user, resolved server-side; a caller must not be able to name someone else. */
export interface ApproveRunGateBody {
  decision?: 'SIGNED' | 'REJECTED';
  contextItemVersionId?: string;
  attestationHash?: string;
}
