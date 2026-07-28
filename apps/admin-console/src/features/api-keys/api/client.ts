/** API key administration (capabilities-matrix row 14). */

import { deleteJson, getJson, patchJson, postJson } from '@/shared/api';
import type { ListParams, Paginated } from '@/shared/api';
import type { ApiKey, ApiKeyScopeCatalog, ApiKeyUsage, CreateApiKeyRequest, CreateApiKeyResult, UpdateApiKeyRequest } from './types';

const BASE = 'admin/api-keys';

/** Scope catalog grouped by category — feeds the scope picker + validation. */
export function getScopes(): Promise<ApiKeyScopeCatalog> {
  return getJson(`${BASE}/scopes`);
}

export function listApiKeys(params?: ListParams): Promise<Paginated<ApiKey>> {
  return getJson(BASE, params);
}

export function getApiKey(id: string): Promise<ApiKey> {
  return getJson(`${BASE}/${encodeURIComponent(id)}`);
}

/** The rawKey in the result is displayed exactly once — never stored. */
export function createApiKey(body: CreateApiKeyRequest): Promise<CreateApiKeyResult> {
  return postJson(BASE, body);
}

export function updateApiKey(id: string, body: UpdateApiKeyRequest): Promise<ApiKey> {
  return patchJson(`${BASE}/${encodeURIComponent(id)}`, body);
}

export function revokeApiKey(id: string): Promise<ApiKey> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/revoke`);
}

/** Revokes the old secret and returns a fresh one-time rawKey. */
export function rotateApiKey(id: string): Promise<CreateApiKeyResult> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/rotate`);
}

export function getApiKeyUsage(id: string): Promise<ApiKeyUsage> {
  return getJson(`${BASE}/${encodeURIComponent(id)}/usage`);
}

export function deleteApiKey(id: string): Promise<ApiKey> {
  return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}
