/**
 * Workflow Runs client (TASK-723, Phase C). Gateway-relative paths under the
 * /api/hope BFF proxy. `admin/workflow-runs` is the tenant-scoped
 * DEFINITION-scoped runs plane (distinct from `/admin/agent-trajectory`, the
 * tier 10-19 cross-tenant platform-ops plane `ai-operations-runs` already
 * covers — README §2.4, cross-linked not forked).
 */

import { getJson } from '@/shared/api';
import type { ListWorkflowRunsParams, RunTrace, WorkflowDefinitionSlice, WorkflowRun, WorkflowRunsPage } from './types';

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
