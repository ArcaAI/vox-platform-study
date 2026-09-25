/**
 * TASK-1005 §13 L-RUI — the catalogue-first model-residency plane.
 * Platform-admin only (D-11); every call is a gateway route behind the BFF proxy.
 */

import { getJson, patchWithEtag, postJson } from '@/shared/api';
import type {
  CreatePolicyRequest,
  ModelResidencyCatalogueResponse,
  ResidencyPolicy,
  UnloadModelRequest,
  UnloadModelResponse,
  UpdatePolicyRequest,
} from './types';

const BASE = 'admin/model-residency';

export function getModelResidencyCatalogue(): Promise<ModelResidencyCatalogueResponse> {
  return getJson(`${BASE}/catalogue`);
}

/** Fast, synchronous (200) — refused 409 `IN_FLIGHT` unless `force: true`. */
export function unloadModel(body: UnloadModelRequest): Promise<UnloadModelResponse> {
  return postJson(`${BASE}/unload`, body);
}

export function createResidencyPolicy(body: CreatePolicyRequest): Promise<ResidencyPolicy> {
  return postJson(`${BASE}/policies`, body);
}

/**
 * `expectedVersion` is already known from the catalogue row being edited
 * (`keepPolicy.policyVersion`), so the If-Match value is built from it
 * directly rather than round-tripping through a separate by-id GET (the
 * gateway only ever mints the strong `"<n>"` form — `packages/applications`
 * `ETagInterceptor`).
 */
export function updateResidencyPolicy(id: string, patch: UpdatePolicyRequest, expectedVersion: number): Promise<ResidencyPolicy> {
  return patchWithEtag<ResidencyPolicy>(`${BASE}/policies/${encodeURIComponent(id)}`, { ...patch, expectedVersion }, `"${expectedVersion}"`).then(
    (result) => result.data,
  );
}
