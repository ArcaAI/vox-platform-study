/**
 * Wire types for the Workbench. Shapes mirror the gateway DTOs in
 * @arcaai/applications (`WorkflowDefinitionResponse` / `WorkflowTestFixtureResponse` /
 * `SandboxRunResponse` / `SandboxRunStatusResponse` / `RunTraceResponse`). The console cannot
 * import server packages, so they are re-declared here — the same convention
 * `features/workflow-runs/api/types.ts` documents ("features never import one another", rule 13).
 */

/** A read-only slice of `GET admin/workflow-definitions` — the definition picker only needs identity. */
export interface WorkflowDefinitionSummary {
  id: string;
  slug: string;
  name: string;
  versionNumber: number;
  status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'DEPRECATED' | string;
  compiledConfig: Record<string, unknown> | null;
}

/** Offset-paginated list envelope (matches `@/shared/api`'s `Paginated<T>`). */
export interface DefinitionsPage {
  data: WorkflowDefinitionSummary[];
  count: number;
  limit: number;
  page: number;
}

/** `WorkflowTestFixtureResponse` — a saved per-tenant synthetic test input. */
export interface Fixture {
  id: string;
  name: string;
  description?: string | null;
  paletteId?: string | null;
  workflowDefinitionId?: string | null;
  /**
   * Encrypted at rest (Vault Transit) and disclosed ONLY by the single-fixture
   * reads — the list endpoint omits it. Absent means "not disclosed on this
   * surface", never "empty fixture".
   */
  input?: Record<string, unknown>;
  resourceStatus?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface FixturesPage {
  data: Fixture[];
  count: number;
  limit: number;
  page: number;
}

export interface CreateFixtureBody {
  name: string;
  description?: string;
  workflowDefinitionId?: string;
  input: Record<string, unknown>;
}

export interface UpdateFixtureBody {
  name?: string;
  description?: string;
  input?: Record<string, unknown>;
  expectedVersion: number;
}

/** `202` body of `POST .../sandbox-runs` (`SandboxRunResponse`). */
export interface SandboxRun {
  runId: string;
  status: 'started' | 'already_running';
  statusUrl: string;
  streamUrl: string;
}

export type SandboxRunLiveStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT' | string;

/** `GET .../sandbox-runs/:runId` (`SandboxRunStatusResponse`). */
export interface SandboxRunStatus {
  runId: string;
  workflowDefinitionId: string;
  status: SandboxRunLiveStatus;
  stages: Record<string, unknown>[];
  startedAt: string | null;
  endedAt: string | null;
}

export interface StartSandboxRunBody {
  fixtureId?: string;
  input?: Record<string, unknown>;
}

/** One node-execution rollup within a run's trace — `RunNodeRollupResponse`, re-declared per
 *  the cross-feature rule. See `features/workflow-runs/api/types.ts`'s matching declaration for
 *  the full field-meaning notes (order is the closest thing to node identity; `errorCode`
 *  cannot distinguish degraded from failed; attempts are a DERIVED grouping). */
export interface RunNodeRollup {
  nodeType: string;
  order: number;
  status: 'STARTED' | 'OK' | 'ERROR' | 'SKIPPED' | 'TIMEOUT' | string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  attemptSeqs: number[];
  attemptCount: number;
  attemptGroupingIsDerived: boolean;
}

/**
* `GET admin/workflow-runs/:runId/trace` (`RunTraceResponse`) — reused verbatim for the
 * Workbench's own node inspector: a sandbox run IS a `WorkflowRun` row like
 * any other, so the SAME bounded trajectory read built serves both surfaces.
 */
export interface RunTrace {
  run: {
    id: string;
    status: SandboxRunLiveStatus;
    isSandbox: boolean;
    /**
     * `RunTraceResponse.run` is the FULL `WorkflowRunResponse`, so these counts are
     * already on the wire — this slice previously dropped them. They are optional here because
     * an older/degraded gateway response may omit them, and "absent" must never render as `0`
     * (pitfall 1 again: a fabricated zero reads as "nothing went wrong").
     *
     * `degradedNodeCount` matters disproportionately: a degraded node — one that produced a
     * marked nothing — has NO per-node representation, because `AgentStepStatus` is
     * `STARTED | OK | ERROR | SKIPPED | TIMEOUT` and `RunNodeRollupResponse`'s own docs record
     * that degraded and critically-failed nodes both persist as `ERROR`. This run-level count is
     * the only place degradation is observable at all.
 */
    nodeCount?: number | null;
    failedNodeCount?: number | null;
    degradedNodeCount?: number | null;
    firstErrorCode?: string | null;
  };
  nodes: RunNodeRollup[];
  stepCount: number;
  truncated: boolean;
  tracePruned: boolean;
}
