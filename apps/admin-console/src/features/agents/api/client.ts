import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag, type ListParams, type WithEtag } from '@/shared/api';
import type {
  Agent,
  AgentAssignment,
  AgentBundle,
  AgentLineage,
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
/**
 * TASK-965 — the lineage register's query.
 *
 * `task` is first-class. `search`/`searchFields`/`filters` are the standard grammar, but they are
 * applied to the VERSION ROWS *before* the fold, so a predicate that differs between the versions
 * of one lineage (status, tags, name) silently changes the folded counters and pointers as well
 * as the membership. Only fold-safe predicates — `task`, `slug`, and a `search` over `slug` —
 * are wired into the screen's facets for that reason.
 */
export type AgentLineageListParams = ListParams & { task?: AgentTask };

/** The standard `{ count, page, limit, data }` envelope, where `count` counts LINEAGES. */
export interface AgentLineagePage {
  count: number;
  page: number;
  limit: number;
  data: AgentLineage[];
}

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

/**
 * TASK-965 (OD-965-3) — the LINEAGE register: one row per slug, paginated by LINEAGE.
 *
 * `count` in the envelope counts LINEAGES, which is what the header must say; `GET admin/agents`
 * counted versions and the screen said "12 agent versions" where an admin reads "12 agents"
 * (AG-14). `task` is a first-class query field (like `paletteKey` on the workflow list) — the
 * generic `filters=task[equals]:…` grammar also works, but the natural `?task=` would otherwise
 * be a 400 under `forbidNonWhitelisted`.
 */
export function listAgentLineages(params?: AgentLineageListParams): Promise<AgentLineagePage> {
  return getJson(`${BASE}/lineages`, params);
}

/**
 * One lineage by slug — the deep-link path (`/agents?slug=…`), used only when the row is NOT on
 * the page the grid has loaded. `slug[iequals]` is fold-safe: a slug is identical on every
 * version of its lineage, so narrowing on it drops no row from the fold (a `status` or `tags`
 * filter WOULD — see the note on `AgentLineageListParams`).
 */
export async function getAgentLineageBySlug(slug: string): Promise<AgentLineage | null> {
  const page = await listAgentLineages({ filters: `slug[iequals]:${slug}`, limit: 5, page: 1 });
  return page.data.find((lineage) => lineage.slug === slug) ?? null;
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

/**
 * TASK-965 (OD-965-1) — rollback. Moves the `isActive` pointer to an ALREADY-PUBLISHED version
 * and demotes the sibling that held it; the demoted version stays PUBLISHED and can be activated
 * again. It touches no published bytes, which is why it is allowed on an immutable row where an
 * edit is not — and why it carries NO `If-Match`: like validate/publish/deprecate it is a state
 * transition, not a compare-and-set write (`AgentAdminController` declares no `@RequiresIfMatch`).
 */
export function activateAgent(id: string): Promise<Agent> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/activate`, {});
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
