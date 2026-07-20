/** AI model registry admin (capabilities-matrix row 8). GLOBAL_ADMIN only. */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { ListParams, WithEtag } from '@/shared/api';
import type {
    AiModel,
    CreateModelRequest,
    DiscoveryResponse,
    PaginatedModels,
    RegisterDiscoveredModelRequest,
    UpdateModelRequest,
} from './types';

const BASE = 'admin/ai-models';

/** All rows, un-paginated (the gateway's fetchAll). */
export function listModels(): Promise<AiModel[]> {
    return getJson(BASE);
}

/** Paginated variant — note the custom envelope with total/totalPages. */
export function listModelsPaginated(params?: ListParams): Promise<PaginatedModels> {
    return getJson(`${BASE}/list`, params);
}

export function getModel(id: string): Promise<WithEtag<AiModel | null>> {
    return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function getModelBySlug(slug: string): Promise<WithEtag<AiModel | null>> {
    return getWithEtag(`${BASE}/slug/${encodeURIComponent(slug)}`);
}

export function createModel(body: CreateModelRequest): Promise<AiModel> {
    return postJson(BASE, body);
}

/** OCC PATCH: If-Match + body expectedVersion derived from the read ETag. */
export function updateModel(id: string, patch: UpdateModelRequest, etag: string): Promise<WithEtag<AiModel>> {
    return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

export function deleteModel(id: string): Promise<void> {
    return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}

/**
 * TASK-528 — merge the registry with the live engine listings. Probes run
 * upstream (SMR aggregates them under a per-provider timeout), so this call can
 * take a couple of seconds: it is fired lazily when the drawer opens, never on
 * page load.
 */
export function discoverModels(provider?: string): Promise<DiscoveryResponse> {
    return getJson(`${BASE}/discovery`, provider ? { provider } : undefined);
}

/** Explicit `discovered` → `registered` transition; the only mutating discovery path. */
export function registerDiscoveredModel(body: RegisterDiscoveredModelRequest): Promise<AiModel> {
    return postJson(`${BASE}/discovery/register`, body);
}
