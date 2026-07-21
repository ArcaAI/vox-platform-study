/**
 * Agents & prompt-template administration (capabilities-matrix row 25). All
 * paths are gateway-relative under the /api/hope BFF proxy. Two routes are
 * optimistic-concurrency writes requiring If-Match: PATCH :id AND POST
 * :id/test (the test run persists lastTestScore/lastTestOutput). The version
 * activate POST is server-driven (no If-Match). assign-department carries the
 * DEPARTMENT row's expectedVersion, so the dialog reads /admin/departments
 * first (that list also feeds the department filter/select).
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag } from '@/shared/api';
import type { Paginated, WithEtag } from '@/shared/api';
import type {
    AssignDepartmentRequest,
    CreateTemplateRequest,
    Department,
    ListTemplatesParams,
    ListUsageRecordsParams,
    PromptTemplate,
    PromptTestResult,
    PromptUsageAnalytics,
    PromptUsageRecord,
    PromptUsageStats,
    PromptVersion,
    PromptVersionDiff,
    TestTemplateRequest,
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
 * Test run — an OCC WRITE with PATCH parity (persists score/output): If-Match
 * required, expectedVersion folded into the body from the same ETag. The
 * result carries the row's NEW version so the caller can continue without a
 * re-fetch.
 */
export async function testTemplate(id: string, body: TestTemplateRequest, etag: string): Promise<PromptTestResult> {
    const response = await request<PromptTestResult>(`${templatePath(id)}/test`, {
        method: 'POST',
        body: { ...body, expectedVersion: versionFromEtag(etag) },
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
