/**
 * Agents & prompt-template administration (capabilities-matrix row 25). All
 * paths are gateway-relative under the /api/hope BFF proxy. Two routes are
 * optimistic-concurrency writes requiring If-Match: PATCH :id AND POST
 * :id/test/finalize (which persists lastTestScore/lastTestOutput once the test
 * stream completes — POST :id/test itself is a non-writing ack). The version
 * activate POST is server-driven (no If-Match). assign-department carries the
 * DEPARTMENT row's expectedVersion, so the dialog reads /admin/departments
 * first (that list also feeds the department filter/select).
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag } from '@/shared/api';
import type { Paginated, WithEtag } from '@/shared/api';
import type {
  AgentEvalRunList,
  AgentPromotion,
  AssignDepartmentRequest,
  CreateDepartmentAgentRequest,
  CreateTemplateRequest,
  Department,
  DepartmentAgent,
  DepartmentAgentVersion,
  EvalGoldenCaseList,
  EvalGoldenSetList,
  EvalRunTrigger,
  ListAgentEvalRunsParams,
  ListAgentPromotionsParams,
  ListDepartmentAgentsParams,
  ListEvalGoldenCasesParams,
  ListEvalGoldenSetsParams,
  ListTemplatesParams,
  ListUsageRecordsParams,
  PromptTemplate,
  PromptTestAck,
  PromptTestResult,
  PromptUsageAnalytics,
  PromptUsageRecord,
  PromptUsageStats,
  PromptVersion,
  PromptVersionDiff,
  ResolvedContextSchemaBundle,
  TestTemplateRequest,
  UpdateDepartmentAgentRequest,
  UpdateTemplateRequest,
} from './types';

const BASE = 'admin/prompt-templates';

const templatePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** NOTE: `page` is ONE-based on this endpoint (`page || 1` server-side). */
export function listTemplates(params?: ListTemplatesParams): Promise<Paginated<PromptTemplate>> {
  return getJson(BASE, params);
}

export function createTemplate(body: CreateTemplateRequest): Promise<PromptTemplate> {
  return postJson(BASE, body);
}

/** Detail read keeping the ETag for the later PATCH / test run. */
export function getTemplate(id: string): Promise<WithEtag<PromptTemplate>> {
  return getWithEtag(templatePath(id));
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. */
export function updateTemplate(id: string, patch: UpdateTemplateRequest, etag: string): Promise<WithEtag<PromptTemplate>> {
  return patchWithEtag(templatePath(id), { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Soft delete (the platform never hard-deletes). */
export function deleteTemplate(id: string): Promise<PromptTemplate> {
  return deleteJson(templatePath(id));
}

export function listVersions(id: string): Promise<PromptVersion[]> {
  return getJson(`${templatePath(id)}/versions`);
}

export function getVersion(id: string, versionNumber: number): Promise<PromptVersion> {
  return getJson(`${templatePath(id)}/versions/${versionNumber}`);
}

/** Server-side field-level diff between two version numbers. */
export function diffVersions(id: string, from: number, to: number): Promise<PromptVersionDiff> {
  return getJson(`${templatePath(id)}/versions/${from}/diff/${to}`);
}

/**
 * Rollback: the server re-reads the row version itself (no If-Match); a
 * concurrent edit between read and CAS write still surfaces as 412.
 */
export function activateVersion(id: string, versionNumber: number): Promise<PromptTemplate> {
  return postJson(`${templatePath(id)}/versions/${versionNumber}/activate`);
}

/**
 * Approve for clinical use — ported from the retired `/prompt-studio` feature;
 * the Governance tab is now the only surface for it.
 *
 * GLOBAL_ADMIN only, enforced SERVER-SIDE (imperative `isSuperAdmin` check in
 * the service, not a decorator — see the AUTH-NOTE on the route). If-Match is
 * REQUIRED: missing → 428, drift → 412, non-global-admin → 403. Idempotent —
 * approving an already-approved row returns it unchanged.
 */
export async function approveTemplate(id: string, reason: string | undefined, etag: string): Promise<PromptTemplate> {
  const response = await request<PromptTemplate>(`${templatePath(id)}/approve`, {
    method: 'POST',
    body: { expectedVersion: versionFromEtag(etag), ...(reason ? { reason } : {}) },
    etag,
  });
  return response.data;
}

/**
 * Test run — ACK ONLY (BUG-018). The endpoint returns immediately and writes
 * nothing, so it no longer requires If-Match: the OCC write moved to
 * `/test/finalize`, called once the SSE stream reports done.
 */
export function testTemplate(id: string, body: TestTemplateRequest): Promise<PromptTestAck> {
  return postJson(`${templatePath(id)}/test`, body);
}

/**
 * Persists the score/output for a completed test run. This is the OCC write:
 * If-Match required (missing → 428, drift → 412), expectedVersion folded into
 * the body from the same ETag. The result carries the row's NEW version so the
 * caller can keep running without a re-fetch.
 */
export async function finalizeTemplateTest(
  id: string,
  taskId: string,
  etag: string,
  // Echo of the `versionNumber` the run was STARTED with. Scoring reads the
  // tested content/variables, so a pinned-version run must be finalized against
  // the same snapshot — omitting it scores the run against the mutable draft.
  versionNumber?: number,
): Promise<PromptTestResult> {
  const response = await request<PromptTestResult>(`${templatePath(id)}/test/finalize`, {
    method: 'POST',
    body: { taskId, expectedVersion: versionFromEtag(etag), ...(versionNumber !== undefined ? { versionNumber } : {}) },
    etag,
  });
  return response.data;
}

/** All-time per-template usage stats. */
export function getUsageStats(id: string): Promise<PromptUsageStats> {
  return getJson(`${templatePath(id)}/usage`);
}

/** Tenant usage aggregates by department/doctor/day; optionally per template. */
export function getUsageAnalytics(promptTemplateId?: string): Promise<PromptUsageAnalytics> {
  return getJson(`${BASE}/analytics/usage`, { promptTemplateId });
}

/** Raw run rows, newest first. NOTE: `page` is ZERO-based here (default 0). */
export function listUsageRecords(params?: ListUsageRecordsParams): Promise<Paginated<PromptUsageRecord>> {
  return getJson(`${BASE}/usage-records`, params);
}

/** Assigns templates to a department's prompt slots (manage:Department). */
export function assignDepartment(body: AssignDepartmentRequest): Promise<Department> {
  return postJson(`${BASE}/assign-department`, body);
}

/** Department directory for the assign dialog + filter (plain array). */
export function listDepartments(): Promise<Department[]> {
  return getJson('admin/departments');
}

/**
 * `DepartmentAgent` CRUD (TASK-546, `admin/department-agents`) — the Agent
 * Catalog's first-class rows. ZERO-based `page`, the platform standard (this
 * endpoint does NOT share the ONE-based deviation of `admin/prompt-templates`
 * above).
 */
const DEPARTMENT_AGENTS_BASE = 'admin/department-agents';

const departmentAgentPath = (id: string) => `${DEPARTMENT_AGENTS_BASE}/${encodeURIComponent(id)}`;

export function listDepartmentAgents(params?: ListDepartmentAgentsParams): Promise<Paginated<DepartmentAgent>> {
  return getJson(DEPARTMENT_AGENTS_BASE, params);
}

/** Detail read keeping the ETag for the later PATCH. */
export function getDepartmentAgent(id: string): Promise<WithEtag<DepartmentAgent>> {
  return getWithEtag(departmentAgentPath(id));
}

export function createDepartmentAgent(body: CreateDepartmentAgentRequest): Promise<DepartmentAgent> {
  return postJson(DEPARTMENT_AGENTS_BASE, body);
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. */
export function updateDepartmentAgent(id: string, patch: UpdateDepartmentAgentRequest, etag: string): Promise<WithEtag<DepartmentAgent>> {
  return patchWithEtag(departmentAgentPath(id), { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Soft delete (the platform never hard-deletes). 403s on a locked template copy. */
export function deleteDepartmentAgent(id: string): Promise<DepartmentAgent> {
  return deleteJson(departmentAgentPath(id));
}

/** Atomic default flip within the row's department — NOT If-Match gated. */
export function setDefaultDepartmentAgent(id: string): Promise<DepartmentAgent> {
  return postJson(`${departmentAgentPath(id)}/set-default`);
}

/**
 * Pin (or, with `null`, track latest APPROVED). Content-affecting but NOT
 * If-Match gated — the server validates the target version server-side
 * (400 if it isn't an existing APPROVED snapshot; 403 on a locked template).
 */
export function pinDepartmentAgent(id: string, versionNumber: number | null): Promise<DepartmentAgent> {
  return postJson(`${departmentAgentPath(id)}/pin`, { versionNumber });
}

/**
 * The immutable loop-configuration version history (TASK-659/672), newest
 * first — a plain array like `listVersions` on the PromptTemplate surface
 * above, never a paginated envelope.
 */
export function listDepartmentAgentVersions(id: string): Promise<DepartmentAgentVersion[]> {
  return getJson(`${departmentAgentPath(id)}/versions`);
}

/**
 * The RESOLVED consultation context schema (TASK-658) a department's loop
 * config must pick `subscribedKinds`/`writeScope` from — `GET
 * tenant/me/context-schema`, the client-discovery sibling of `/tenant/me/config`
 * (never the admin CRUD surface, which is TASK-666's own feature). A tenant
 * with nothing configured gets a 200 with null fields, not a 404.
 */
export function getResolvedContextSchema(departmentId?: string): Promise<ResolvedContextSchemaBundle> {
  return getJson('tenant/me/context-schema', departmentId ? { departmentId } : undefined);
}

// ---------------------------------------------------------------------------
// Eval-gated promotion (TASK-549) — golden-set picker + scoped eval-run read
// + run-now for the Governance tab's Eval panel. Golden-set CRUD and the full
// eval-runs grid stay on `/harness/observability` (one authoritative editor
// per resource, rule 13) — this is a read-mostly, agent-scoped view.
// ---------------------------------------------------------------------------

const HARNESS_BASE = 'admin/harness';

/** NOTE: `page` is ONE-based on this endpoint (unlike the platform's 0-based lists). */
export function listEvalGoldenSets(params?: ListEvalGoldenSetsParams): Promise<EvalGoldenSetList> {
  return getJson(`${HARNESS_BASE}/golden-sets`, params);
}

/** NOTE: `page` is ONE-based on this endpoint (unlike the platform's 0-based lists). */
export function listAgentEvalRuns(params?: ListAgentEvalRunsParams): Promise<AgentEvalRunList> {
  return getJson(`${HARNESS_BASE}/eval-runs`, params);
}

/**
 * A golden set's cases, PHI-safe metadata only — feeds the Test Bench's
 * "Golden case" example-data picker (POST :id/test `goldenCaseId`).
 */
export function listEvalGoldenCases(goldenSetId: string, params?: ListEvalGoldenCasesParams): Promise<EvalGoldenCaseList> {
  return getJson(`${HARNESS_BASE}/golden-sets/${encodeURIComponent(goldenSetId)}/cases`, params);
}

/** Synchronous run-now — tenant admins run their own sets; a SYSTEM set is global-admin-only. */
export function runGoldenSetEval(goldenSetId: string): Promise<EvalRunTrigger> {
  return postJson(`${HARNESS_BASE}/golden-sets/${encodeURIComponent(goldenSetId)}/run`);
}

// ---------------------------------------------------------------------------
// Cross-tenant agent promotion lineage (TASK-663/672) — a READ-only view of
// promotions INTO the working tenant, filtered to one target agent for the
// Lineage tab. Promotion itself (POST admin/agent-promotions) is out of this
// ticket's scope; only the audit trail it writes is surfaced here.
// ---------------------------------------------------------------------------

const AGENT_PROMOTIONS_BASE = 'admin/agent-promotions';

/** ZERO-based `page`, the platform standard (matches `listDepartmentAgents` above). */
export function listAgentPromotions(params?: ListAgentPromotionsParams): Promise<Paginated<AgentPromotion>> {
  return getJson(AGENT_PROMOTIONS_BASE, params);
}
