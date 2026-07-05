/**
 * ASR pipeline administration client (capabilities-matrix row 27). All paths
 * are gateway-relative; the shared core prepends the BFF proxy mount. The
 * public read `GET /audio/pipelines` (SDK pickers) is deliberately NOT here —
 * this surface is the admin plane.
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
    AssignTenantResult,
    CreatePipelineRequest,
    PaginatedPipelines,
    Pipeline,
    PipelineVersion,
    UpdatePipelineRequest,
    ValidatePipelineResult,
} from './types';

const BASE = 'admin/audio/pipelines';

/** All pipelines of every status (the admin list keeps DISABLED rows visible). */
export function listPipelines(): Promise<Pipeline[]> {
    return getJson(BASE);
}

/** NOTE: custom envelope { data, total, page, limit, totalPages }; page is 1-based. */
export function listPipelinesPage(params?: { page?: number; limit?: number }): Promise<PaginatedPipelines> {
    return getJson(`${BASE}/list`, params);
}

/** Detail read keeping the ETag for the later If-Match PATCH/toggle. */
export function getPipeline(id: string): Promise<WithEtag<Pipeline>> {
    return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function getPipelineBySlug(slug: string): Promise<WithEtag<Pipeline>> {
    return getWithEtag(`${BASE}/slug/${encodeURIComponent(slug)}`);
}

export function createPipeline(body: CreatePipelineRequest): Promise<Pipeline> {
    return postJson(BASE, body);
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. */
export async function updatePipeline(id: string, patch: UpdatePipelineRequest, etag: string): Promise<WithEtag<Pipeline>> {
    return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

export function deletePipeline(id: string): Promise<void> {
    return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}

/** Preflight the YAML before saving (never mutates). */
export function validatePipelineConfig(configYaml: string): Promise<ValidatePipelineResult> {
    return postJson(`${BASE}/validate`, { configYaml });
}

/** Same-tenant assignment (promotes to tenant default); cross-tenant rejects. */
export function assignPipelineTenant(id: string, tenantId: string): Promise<AssignTenantResult> {
    return postJson(`${BASE}/${encodeURIComponent(id)}/assign-tenant`, { tenantId });
}

/** Flag flip, not a content edit — deliberately no If-Match. */
export function setDefaultPipeline(id: string): Promise<Pipeline> {
    return postJson(`${BASE}/${encodeURIComponent(id)}/set-default`);
}

/**
 * Enable/disable (ENABLED <-> DISABLED). OCC-guarded: If-Match carries the
 * version; the body is `{ enabled }` ONLY — TogglePipelineRequest declares no
 * other field and the gateway pipe runs forbidNonWhitelisted.
 */
export async function togglePipeline(id: string, enabled: boolean, etag: string): Promise<WithEtag<Pipeline>> {
    return request(`${BASE}/${encodeURIComponent(id)}/toggle`, { method: 'PATCH', body: { enabled }, etag });
}

/** Config-version snapshots, newest first. */
export function listPipelineVersions(id: string): Promise<PipelineVersion[]> {
    return getJson(`${BASE}/${encodeURIComponent(id)}/versions`);
}

export function getPipelineVersion(id: string, versionNumber: number): Promise<PipelineVersion> {
    return getJson(`${BASE}/${encodeURIComponent(id)}/versions/${versionNumber}`);
}
