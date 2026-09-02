/**
 * Workflow Runs client (TASK-723, Phase C). Gateway-relative paths under the
 * /api/hope BFF proxy. `admin/workflow-runs` is the tenant-scoped
 * DEFINITION-scoped runs plane (distinct from `/admin/agent-trajectory`, the
 * tier 10-19 cross-tenant platform-ops plane `ai-operations-runs` already
 * covers — README §2.4, cross-linked not forked).
 */

import { getJson, postJson } from '@/shared/api';
import type {
  ApproveRunGateBody,
  ListWorkflowRunsParams,
  RunGateState,
  RunTrace,
  WorkflowDefinitionSlice,
  WorkflowRun,
  WorkflowRunsPage,
} from './types';

const WORKFLOW_RUNS = 'admin/workflow-runs';
const WORKFLOW_DEFINITIONS = 'admin/workflow-definitions';

export function listWorkflowRuns(params?: ListWorkflowRunsParams): Promise<WorkflowRunsPage> {
  return getJson(WORKFLOW_RUNS, params);
}

export function getWorkflowRun(runId: string): Promise<WorkflowRun> {
  return getJson(`${WORKFLOW_RUNS}/${encodeURIComponent(runId)}`);
}

export function getRunTrace(runId: string): Promise<RunTrace> {
  return getJson(`${WORKFLOW_RUNS}/${encodeURIComponent(runId)}/trace`);
}

/**
 * The pinned, immutable `WorkflowDefinition` version a run executed against
 * (Task 8's read-only deep link). `admin/workflow-definitions/:id` is
 * TASK-734's definition CRUD surface — read-only here, only the fields
 * `WorkflowDefinitionSlice` declares are consumed.
 */
export function getWorkflowDefinitionVersion(workflowVersionId: string): Promise<WorkflowDefinitionSlice> {
  return getJson(`${WORKFLOW_DEFINITIONS}/${encodeURIComponent(workflowVersionId)}`);
}

/**
 * Live gate state. Read from the gate child workflow server-side rather than from the run row,
 * because `WorkflowRunStatus` has no "waiting on a human" member — a run parked at its gate and
 * a run busy generating text are both `RUNNING`.
 */
export function getRunGate(runId: string): Promise<RunGateState> {
  return getJson(`${WORKFLOW_RUNS}/${encodeURIComponent(runId)}/gate`);
}

/** Release the gate. The approving clinician is the acting user — never sent from here. */
export function approveRunGate(runId: string, body: ApproveRunGateBody): Promise<RunGateState> {
  return postJson(`${WORKFLOW_RUNS}/${encodeURIComponent(runId)}/gate/approve`, body);
}

/**
 * The run-event SSE endpoint (TASK-849 lane A/C). Lives on a DIFFERENT controller
 * (`WorkflowsController`, `@Controller('workflows')`) than the rest of this client —
 * the tenant-scoped runs/observability plane above reads the trajectory-backed trace,
 * this one is the interpreter's own snapshot-then-delta push. `slug` (not just `runId`)
 * is required because the route is `:slug/runs/:runId/stream`; callers get it off the
 * already-fetched `WorkflowRun.workflowSlug`.
 *
 * Path is relative to /api/v1 — the browser connects DIRECTLY to the gateway with a
 * single-use ticket (`useEventStream`), never through the BFF proxy `getJson` uses.
 */
export function workflowRunStreamPath(slug: string, runId: string): string {
  return `workflows/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/stream`;
}

/** Ticket scope — must match the route's `@StreamScope({ namespace: 'workflow_run', param: 'runId' })`. */
export function workflowRunStreamScope(runId: string): string {
  return `workflow_run:${runId}`;
}
