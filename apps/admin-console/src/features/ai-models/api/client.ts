/** AI model registry admin (capabilities-matrix row 8). SUPER_ADMIN only. */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { ListParams, WithEtag } from '@/shared/api';
import { SYSTEM_TENANT_ID } from '@/shared/catalog';
import type {
  AiModel,
  CreateModelRequest,
  DiscoveryResponse,
  ModelDownloadState,
  ModelRegistryConnectionStatus,
  PaginatedModels,
  RegisterDiscoveredModelRequest,
  StartModelDownloadResponse,
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
 * Merge the registry with the live engine listings. Probes run
 * upstream (the text-generation service aggregates them under a per-provider timeout), so this call can
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

// =============================================================================
// Download — FROZEN contract (a sibling lane owns the gateway side; see
// api/types.ts). 409 surfaces as a GatewayError the caller maps to a message.
// =============================================================================

/** Starts (or reports 409 already-in-flight for) a weight download. */
export function startModelDownload(id: string): Promise<StartModelDownloadResponse> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/download`);
}

/** Current download job state — poll this while `status === 'DOWNLOADING'`. */
export function getModelDownloadState(id: string): Promise<ModelDownloadState> {
  return getJson(`${BASE}/${encodeURIComponent(id)}/download`);
}

/**
 * Read-only status of the platform's S3 model-registry connection (the
 * SYSTEM row — TASK-799 owner ruling: the weight-fetch plane is
 * platform-managed, so this is pinned to SYSTEM regardless of the caller's
 * working tenant). `features/ai-providers` owns the editor for this row.
 */
export function getModelRegistryConnectionStatus(): Promise<ModelRegistryConnectionStatus> {
  return getJson('admin/providers/model-registry/s3', { tenantId: SYSTEM_TENANT_ID });
}
