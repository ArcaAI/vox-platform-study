/** AI model registry admin (capabilities-matrix row 8). GLOBAL_ADMIN only. */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { ListParams, WithEtag } from '@/shared/api';
import type { AiModel, CreateModelRequest, PaginatedModels, UpdateModelRequest } from './types';

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
