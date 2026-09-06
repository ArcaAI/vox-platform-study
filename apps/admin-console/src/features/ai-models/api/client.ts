/** AI model registry admin (capabilities-matrix row 8). SUPER_ADMIN only — rows live in the SYSTEM tenant (TASK-860). */

import { deleteJson, getJson, getWithEtag, patchJson, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { ListParams, WithEtag } from '@/shared/api';
import { SYSTEM_TENANT_ID } from '@/shared/catalog';
import type {
  AiModel,
  AiTaskKind,
  CreateModelRequest,
  DiscoveryResponse,
  ModelDownloadState,
  ModelInventoryReport,
  ModelRegistryConnectionStatus,
  PaginatedModels,
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
 * The super-admin "platform default for task" election (TASK-860). Not an OCC
 * field edit — the gateway also clears each task from its previous holder —
 * so it has its own route and no If-Match.
 */
export function setModelPlatformDefault(id: string, tasks: AiTaskKind[]): Promise<AiModel> {
  return patchJson(`${BASE}/${encodeURIComponent(id)}/platform-default`, { tasks });
}

/**
 * Run the bucket inventory: measures every row's `availability` against
 * `s3://hope-models` and lists the prefixes in the bucket no row references.
 * Synchronous on the gateway (one listing + one manifest read per row).
 */
export function runModelInventory(): Promise<ModelInventoryReport> {
  return postJson(`${BASE}/inventory`);
}

/**
 * The LAST inventory report, without measuring anything (TASK-890 J1 MINOR-7).
 *
 * The "In bucket, not registered" drawer used to be disabled until the operator
 * ran a full bucket sweep in THIS tab, because the report lived nowhere else.
 * The gateway now keeps it, so a fresh load can read it. `null` when the
 * platform has none stored — a real answer, not an empty bucket.
 */
export function getLastModelInventory(): Promise<ModelInventoryReport | null> {
  return getJson(`${BASE}/inventory`);
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
 * SYSTEM row — owner ruling: the weight-fetch plane is
 * platform-managed, so this is pinned to SYSTEM regardless of the caller's
 * working tenant). `features/ai-providers` owns the editor for this row.
 */
export function getModelRegistryConnectionStatus(): Promise<ModelRegistryConnectionStatus> {
  return getJson('admin/providers/model-registry/s3', { tenantId: SYSTEM_TENANT_ID });
}
