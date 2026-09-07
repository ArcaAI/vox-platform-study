/**
 * Sandbox client. Gateway-relative paths under the /api/hope BFF proxy.
 * Moved from `features/workbench/api/client.ts` (TASK-893) — `listWorkflowDefinitions` did not
 * move, see `./types.ts`'s file banner.
 */

import { deleteJson, getJson, patchJson, postJson } from '@/shared/api';
import type { CreateFixtureBody, Fixture, FixturesPage, RunTrace, SandboxRun, SandboxRunStatus, StartSandboxRunBody, UpdateFixtureBody } from './types';

const WORKFLOW_DEFINITIONS = 'admin/workflow-definitions';
const WORKFLOW_TEST_FIXTURES = 'admin/workflow-test-fixtures';
const WORKFLOW_RUNS = 'admin/workflow-runs';

export function listFixtures(params?: { page?: number; limit?: number }): Promise<FixturesPage> {
  return getJson(WORKFLOW_TEST_FIXTURES, params);
}

export function createFixture(body: CreateFixtureBody): Promise<Fixture> {
  return postJson(WORKFLOW_TEST_FIXTURES, body);
}

export function updateFixture(id: string, body: UpdateFixtureBody): Promise<Fixture> {
  return patchJson(`${WORKFLOW_TEST_FIXTURES}/${encodeURIComponent(id)}`, body);
}

export function deleteFixture(id: string): Promise<Fixture> {
  return deleteJson(`${WORKFLOW_TEST_FIXTURES}/${encodeURIComponent(id)}`);
}

export function startSandboxRun(definitionId: string, body: StartSandboxRunBody): Promise<SandboxRun> {
  return postJson(`${WORKFLOW_DEFINITIONS}/${encodeURIComponent(definitionId)}/sandbox-runs`, body);
}

export function getSandboxRunStatus(definitionId: string, runId: string): Promise<SandboxRunStatus> {
  return getJson(`${WORKFLOW_DEFINITIONS}/${encodeURIComponent(definitionId)}/sandbox-runs/${encodeURIComponent(runId)}`);
}

export function cancelSandboxRun(definitionId: string, runId: string): Promise<{ runId: string; status: string }> {
  return postJson(`${WORKFLOW_DEFINITIONS}/${encodeURIComponent(definitionId)}/sandbox-runs/${encodeURIComponent(runId)}/cancel`);
}

/** The sandbox seam's per-node inspector reuses this bounded trace read verbatim. */
export function getRunTrace(runId: string): Promise<RunTrace> {
  return getJson(`${WORKFLOW_RUNS}/${encodeURIComponent(runId)}/trace`);
}
