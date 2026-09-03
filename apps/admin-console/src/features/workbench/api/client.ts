/**
 * Workbench client. Gateway-relative paths under the /api/hope BFF proxy.
 */

import { deleteJson, getJson, patchJson, postJson } from '@/shared/api';
import type {
  CreateFixtureBody,
  DefinitionsPage,
  Fixture,
  FixturesPage,
  RunTrace,
  SandboxRun,
  SandboxRunStatus,
  StartSandboxRunBody,
  UpdateFixtureBody,
} from './types';

const WORKFLOW_DEFINITIONS = 'admin/workflow-definitions';
const WORKFLOW_TEST_FIXTURES = 'admin/workflow-test-fixtures';
const WORKFLOW_RUNS = 'admin/workflow-runs';

export function listWorkflowDefinitions(params?: { page?: number; limit?: number }): Promise<DefinitionsPage> {
  return getJson(WORKFLOW_DEFINITIONS, params);
}

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

/** The Workbench's per-node inspector reuses bounded trace read verbatim ( 8). */
export function getRunTrace(runId: string): Promise<RunTrace> {
  return getJson(`${WORKFLOW_RUNS}/${encodeURIComponent(runId)}/trace`);
}
