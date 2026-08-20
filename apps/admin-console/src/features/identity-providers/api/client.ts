/**
 * Tenant-scoped external OIDC identity provider administration.
 * All paths are gateway-relative under the /api/hope BFF
 * proxy. `update`/`testConnection` are If-Match OCC writes (mirrors
 * `TenantIdpConfigAdminController`); `syncDirectory` is fire-and-forget
 * (202 + jobId — see the module doc on `useSyncDirectory` for why there's no
 * client-side progress poll).
 */

import { deleteJson, getJson, getWithEtag, postJson, putWithEtag, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
  CreateTenantIdpConfigRequest,
  DepartmentOption,
  DirectoryCredentials,
  RoleOption,
  SyncDirectoryResult,
  TenantIdpConfig,
  TestConnectionResult,
  UpdateTenantIdpConfigRequest,
} from './types';

const BASE = 'admin/tenant-idp-config';

const providerPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export function listProviders(): Promise<TenantIdpConfig[]> {
  return getJson(BASE);
}

export function createProvider(body: CreateTenantIdpConfigRequest): Promise<TenantIdpConfig> {
  return postJson(BASE, body);
}

/** Detail read keeping the ETag the later PUT must present as If-Match. */
export function getProvider(id: string): Promise<WithEtag<TenantIdpConfig>> {
  return getWithEtag(providerPath(id));
}

/** OCC PUT: If-Match header + body expectedVersion derived from the ETag. */
export function updateProvider(
  id: string,
  patch: Omit<UpdateTenantIdpConfigRequest, 'expectedVersion'>,
  etag: string,
): Promise<WithEtag<TenantIdpConfig>> {
  return putWithEtag(providerPath(id), { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Soft delete (the platform never hard-deletes). */
export function deleteProvider(id: string): Promise<void> {
  return deleteJson(providerPath(id));
}

/**
 * Vault-seals a directory-API credential bundle (shape matches
 * config.directoryProvider). OCC applies, exactly like `updateProvider`:
 * `If-Match` is REQUIRED and CASes against the provider row, so a stale editor
 * gets 412 instead of sealing a bundle onto a row that has moved.
 */
export async function setDirectoryCredentials(id: string, credentials: DirectoryCredentials, etag: string): Promise<TenantIdpConfig> {
  return (
    await putWithEtag<TenantIdpConfig>(
      `${providerPath(id)}/directory-credentials`,
      { credentials, expectedVersion: versionFromEtag(etag) },
      etag,
    )
  ).data;
}

/** Discovery + client-construction probe. A successful call flips DRAFT -> ENABLED server-side. */
export function testConnection(id: string): Promise<TestConnectionResult> {
  return postJson(`${providerPath(id)}/test`);
}

/** Enqueues an admin-triggered directory pull (MS Graph / Google). */
export function syncDirectory(id: string): Promise<SyncDirectoryResult> {
  return postJson(`${providerPath(id)}/sync`);
}

/** Department directory for the default-department picker (mirrors the local duplicate in the `agents` feature — features never import each other). */
export function listDepartments(): Promise<DepartmentOption[]> {
  return getJson('admin/departments');
}

/** Role directory for the default-role picker + group->role mapping editor. */
export async function listRoles(): Promise<RoleOption[]> {
  const page = await getJson<{ data: RoleOption[] }>('admin/rbac/roles', { limit: 200 });
  return page.data;
}
