import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag, type WithEtag } from '@/shared/api';
import type {
  Agent,
  AgentAssignment,
  AgentTask,
  CreateAgentRequest,
  Department,
  InstructionTemplate,
  NewAgentVersionRequest,
  PublishAgentRequest,
  RegistryModel,
  UpdateAgentRequest,
  UpsertAgentAssignmentRequest,
} from './types';

const BASE = 'admin/agents';
const ASSIGNMENTS = 'admin/agent-assignments';

export function listAgents(task?: AgentTask): Promise<Agent[]> {
  return getJson(BASE, { ...(task ? { task } : {}), includeTemplates: 'true' });
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

/** Registry rows for the Model step. The registry feature owns the screen; this is a read-only picker feed. */
export function listRegistryModels(): Promise<RegistryModel[]> {
  return getJson('admin/ai-models');
}

/** The instruction library for the Instruction step (APPROVED templates only are bindable). */
export async function listInstructionTemplates(): Promise<InstructionTemplate[]> {
  const page = await getJson<{ data?: InstructionTemplate[] } | InstructionTemplate[]>('admin/prompt-templates', { limit: 200, page: 0 });
  return Array.isArray(page) ? page : (page.data ?? []);
}

export async function listDepartments(): Promise<Department[]> {
  const page = await getJson<{ data?: Department[] } | Department[]>('admin/departments', { limit: 200, page: 0 });
  return Array.isArray(page) ? page : (page.data ?? []);
}
