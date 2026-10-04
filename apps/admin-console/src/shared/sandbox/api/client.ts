/**
 * Sandbox client. Gateway-relative paths under the /api/hope BFF proxy.
 * Moved from `features/workbench/api/client.ts` (TASK-893) — `listWorkflowDefinitions` did not
 * move, see `./types.ts`'s file banner.
 */

import { deleteJson, getJson, patchJson, postJson } from '@/shared/api';
import type {
  CreateFixtureBody,
  CreateSttStreamSessionBody,
  Fixture,
  FixturesPage,
  RunTrace,
  SandboxRun,
  SandboxRunStatus,
  SttStreamSession,
  StartSandboxRunBody,
  UpdateFixtureBody,
} from './types';

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

// --- Test-tab recording (TASK-1036 OD-15) ------------------------------------------------------
// The SAME end-user streaming-session routes the live-transcription playground uses; the sandbox
// run (not this session) creates the sandbox consultation and binds the session to it, so the
// session is opened WITHOUT a consultation.

const STT_SESSION = 'audio/transcription-jobs/stream/session';

export function createSttStreamSession(body: CreateSttStreamSessionBody): Promise<SttStreamSession> {
  return postJson(STT_SESSION, body);
}

export function refreshSttStreamTicket(sessionId: string): Promise<{ ticket: string; ticketExpiresAt: number }> {
  return postJson(`${STT_SESSION}/${encodeURIComponent(sessionId)}/refresh-ticket`);
}

export function closeSttStreamSession(sessionId: string): Promise<void> {
  return deleteJson(`${STT_SESSION}/${encodeURIComponent(sessionId)}`);
}

/** Direct-gateway WS URL (streams never traverse the BFF): one-shot ticket + the tenant claim the WS guard requires. */
export function buildSttWsUrl(apiHost: string, wsPath: string, params: { sessionId: string; ticket: string; tenantId: string }): string {
  const parsed = new URL(apiHost);
  const wsProtocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  const search = new URLSearchParams({ sessionId: params.sessionId, ticket: params.ticket, tenantId: params.tenantId });
  return `${wsProtocol}//${parsed.host}${wsPath}?${search.toString()}`;
}
