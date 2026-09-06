import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag, type WithEtag } from '@/shared/api';
import type {
  Agent,
  AgentAssignment,
  AgentBundle,
  AgentTask,
  AgentTestAck,
  AgentTestResult,
  CloneAgentRequest,
  CreateAgentRequest,
  Department,
  FinalizeAgentTestRequest,
  ImportAgentRequest,
  NewAgentVersionRequest,
  PublishAgentRequest,
  TestAgentRequest,
  UpdateAgentRequest,
  UpsertAgentAssignmentRequest,
} from './types';

const BASE = 'admin/agents';
const ASSIGNMENTS = 'admin/agent-assignments';

/**
 * TASK-890 OD-M — no `includeTemplates`: the SYSTEM reference set is cloned into the tenant at
 * provisioning (`TenantReferenceSetService`), never read live across tenants. `GET admin/agents`
 * therefore answers only rows this tenant owns — including its own clones (`sourceTenantId` names
 * the platform origin; `agent-status-badge.tsx`).
 */
export function listAgents(task?: AgentTask): Promise<Agent[]> {
  return getJson(BASE, task ? { task } : undefined);
}

/** Detail read keeping the ETag for the later If-Match PATCH. */
export function getAgent(id: string): Promise<WithEtag<Agent>> {
  return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function listAgentVersions(id: string): Promise<Agent[]> {
  return getJson(`${BASE}/${encodeURIComponent(id)}/versions`);
}

export function createAgent(body: CreateAgentRequest): Promise<Agent> {
  return postJson(BASE, body);
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. */
export function updateAgent(id: string, patch: UpdateAgentRequest, etag: string): Promise<WithEtag<Agent>> {
  return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

export function deleteAgent(id: string): Promise<Agent> {
  return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}

export function validateAgent(id: string): Promise<Agent> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/validate`, {});
}

export function publishAgent(id: string, body: PublishAgentRequest = {}): Promise<Agent> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/publish`, body);
}

export function newAgentVersion(id: string, body: NewAgentVersionRequest = {}): Promise<Agent> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/versions`, body);
}

export function deprecateAgent(id: string): Promise<Agent> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/deprecate`, {});
}

// TASK-884 — portability. These three address the agent by its lineage SLUG, not its row id:
// a slug is stable across versions and is what an exported file and another tenant both name.

export function exportAgent(slug: string, versionNumber?: number): Promise<AgentBundle> {
  return getJson(`${BASE}/${encodeURIComponent(slug)}/export`, versionNumber ? { versionNumber: String(versionNumber) } : undefined);
}

export function cloneAgent(slug: string, body: CloneAgentRequest): Promise<Agent> {
  return postJson(`${BASE}/${encodeURIComponent(slug)}/clone`, body);
}

export function importAgent(body: ImportAgentRequest): Promise<Agent> {
  return postJson(`${BASE}/import`, body);
}

export function listAgentAssignments(task?: AgentTask): Promise<AgentAssignment[]> {
  return getJson(ASSIGNMENTS, task ? { task } : undefined);
}

export function createAgentAssignment(body: UpsertAgentAssignmentRequest): Promise<AgentAssignment> {
  return postJson(ASSIGNMENTS, body);
}

export function updateAgentAssignment(body: UpsertAgentAssignmentRequest, etag: string): Promise<WithEtag<AgentAssignment>> {
  return patchWithEtag(ASSIGNMENTS, { ...body, expectedVersion: versionFromEtag(etag) }, etag);
}

/** DELETE carries `If-Match` (the row version the client read) — a 428 without it. */
export async function removeAgentAssignment(id: string, version: number, reason?: string): Promise<AgentAssignment> {
  const result = await request<AgentAssignment>(`${ASSIGNMENTS}/${encodeURIComponent(id)}`, { method: 'DELETE', etag: `"${version}"`, params: reason ? { reason } : undefined });
  return result.data;
}

/**
 * TASK-890 §3.8 — the draft-agent test bench. `test` is a dry run by default (nothing generated,
 * nothing metered); `test/finalize` reads a finished non-dry run back SERVER-SIDE by `taskId`.
 */
export function testAgent(id: string, body: TestAgentRequest = {}): Promise<AgentTestAck> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/test`, body);
}

export function finalizeAgentTest(id: string, body: FinalizeAgentTestRequest): Promise<AgentTestResult> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/test/finalize`, body);
}

export async function listDepartments(): Promise<Department[]> {
  const page = await getJson<{ data?: Department[] } | Department[]>('admin/departments', { limit: 200, page: 0 });
  return Array.isArray(page) ? page : (page.data ?? []);
}
