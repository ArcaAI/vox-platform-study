/**
 * TASK-1005 §13 L-RUI — the catalogue-first model-residency plane.
 * Platform-admin only (D-11); every call is a gateway route behind the BFF proxy.
 */

import { getJson, patchWithEtag, postJson, putJson, request } from '@/shared/api';
import type { LoadModelResidencyRequest } from '@/shared/residency';
import type {
  CreatePolicyRequest,
  DismissSuggestionResponse,
  LinkRuntimeKeyRequest,
  LinkRuntimeKeyResponse,
  ModelResidencyLoadPreview,
  ModelResidencyReadiness,
  PinModelRequest,
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

/**
 * TASK-1055 (E9) — "Reset to default": soft-deletes the explicit policy row, so
 * the model falls back to its implicit class (PINNED when it backs the live
 * path, ON_DEMAND otherwise). If-Match comes from the row's `policyVersion`.
 */
export function deleteResidencyPolicy(id: string, expectedVersion: number): Promise<ResidencyPolicy> {
  return request<ResidencyPolicy>(`${BASE}/policies/${encodeURIComponent(id)}`, { method: 'DELETE', etag: `"${expectedVersion}"` }).then(
    (result) => result.data,
  );
}

// ── TASK-1051 ──────────────────────────────────────────────────────────────

/** Dry-run admission for the Load dialog — same body as a load; changes nothing. */
export function previewModelLoad(body: LoadModelResidencyRequest): Promise<ModelResidencyLoadPreview> {
  return postJson(`${BASE}/load/preview`, body);
}

/** Record that a reported engine key IS a catalogue row (audited). */
export function linkRuntimeKey(body: LinkRuntimeKeyRequest): Promise<LinkRuntimeKeyResponse> {
  return postJson(`${BASE}/links`, body);
}

export function dismissResidencySuggestion(id: string): Promise<DismissSuggestionResponse> {
  return postJson(`${BASE}/suggestions/${encodeURIComponent(id)}/dismiss`, {});
}

/** Pin / unpin on the running service (the operator pin, not a policy row). */
export function pinResidencyModel(body: PinModelRequest): Promise<unknown> {
  return putJson(`${BASE}/pins`, body);
}

export function getModelResidencyReadiness(): Promise<ModelResidencyReadiness> {
  return getJson(`${BASE}/readiness`);
}
