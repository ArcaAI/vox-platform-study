import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { AllowedOriginPosture, CreateAllowedOriginRequest, TenantAllowedOrigin, UpdateAllowedOriginRequest } from './types';

const BASE = 'admin/allowed-origins';

export function listAllowedOrigins(): Promise<TenantAllowedOrigin[]> {
  return getJson(BASE);
}

/** FR-4 — `GET /admin/allowed-origins/posture`, reachable by both tenant and global admins. */
export function getAllowedOriginPosture(): Promise<AllowedOriginPosture> {
  return getJson(`${BASE}/posture`);
}

export function getAllowedOrigin(id: string): Promise<WithEtag<TenantAllowedOrigin>> {
  return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function createAllowedOrigin(body: CreateAllowedOriginRequest): Promise<TenantAllowedOrigin> {
  return postJson(BASE, body);
}

export function updateAllowedOrigin(id: string, patch: UpdateAllowedOriginRequest, etag: string): Promise<WithEtag<TenantAllowedOrigin>> {
  return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

export function deleteAllowedOrigin(id: string): Promise<void> {
  return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}
