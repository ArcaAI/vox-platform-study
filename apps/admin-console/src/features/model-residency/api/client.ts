/**
 * TASK-1005 §5.4/§8.1 L-UI — the platform-admin model-residency plane.
 * Platform-admin only (D-11); every call is a gateway route behind the BFF proxy.
 */

import { deleteJson, getJson, patchWithEtag, postJson, putJson } from '@/shared/api';
import type {
  CreatePolicyRequest,
  LoadModelRequest,
  LoadModelResponse,
  ModelResidencyOperation,
  ModelResidencyPolicy,
  ModelResidencyResponse,
  SetPinRequest,
  SetPinResponse,
  UnloadModelRequest,
  UnloadModelResponse,
  UpdatePolicyRequest,
} from './types';

const BASE = 'admin/model-residency';

export function getModelResidency(): Promise<ModelResidencyResponse> {
  return getJson(BASE);
}

/** Async — 202 with `operationId` on a real load, or 200 `already_loaded` (§10.1). */
export function loadModel(body: LoadModelRequest): Promise<LoadModelResponse> {
  return postJson(`${BASE}/load`, body);
}

/** Fast, synchronous (200) — refused 409 `IN_FLIGHT` unless `force: true`. */
export function unloadModel(body: UnloadModelRequest): Promise<UnloadModelResponse> {
  return postJson(`${BASE}/unload`, body);
}

export function setPin(body: SetPinRequest): Promise<SetPinResponse> {
  return putJson(`${BASE}/pins`, body);
}

export function getModelResidencyOperation(operationId: string): Promise<ModelResidencyOperation> {
  return getJson(`${BASE}/operations/${encodeURIComponent(operationId)}`);
}

export function listResidencyPolicies(): Promise<ModelResidencyPolicy[]> {
  return getJson(`${BASE}/policies`);
}

export function createResidencyPolicy(body: CreatePolicyRequest): Promise<ModelResidencyPolicy> {
  return postJson(`${BASE}/policies`, body);
}

/**
 * `expectedVersion` is already known from the row the caller is editing
 * (`ModelResidencyPolicy._version`, carried on every list read), so the
 * If-Match value is built from it directly rather than round-tripping through
 * a separate by-id GET (the gateway only ever mints the strong `"<n>"` form —
 * `packages/applications` `ETagInterceptor`).
 */
export function updateResidencyPolicy(id: string, patch: UpdatePolicyRequest, expectedVersion: number): Promise<ModelResidencyPolicy> {
  return patchWithEtag<ModelResidencyPolicy>(
    `${BASE}/policies/${encodeURIComponent(id)}`,
    { ...patch, expectedVersion },
    `"${expectedVersion}"`,
  ).then((result) => result.data);
}

export function deleteResidencyPolicy(id: string): Promise<void> {
  return deleteJson(`${BASE}/policies/${encodeURIComponent(id)}`);
}
