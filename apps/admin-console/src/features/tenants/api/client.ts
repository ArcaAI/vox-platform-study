/**
 * Tenant administration client (capabilities-matrix rows 3 + 6). All paths are
 * gateway-relative; the shared core prepends the BFF proxy mount.
 */

import { deleteJson, getJson, getWithEtag, patchJson, patchWithEtag, postJson, putWithEtag, request, versionFromEtag } from '@/shared/api';
import type { ListParams, Paginated, WithEtag } from '@/shared/api';
import type {
  CreateTenantRequest,
  PipelineResyncSummary,
  ProvisionTenantRequest,
  Tenant,
  TenantConfig,
  TenantFrontendConfig,
  TenantProvisionResult,
  TenantStorageSnapshot,
  TenantUsage,
  UpdateTenantConfigItem,
  UpdateTenantRequest,
  UpsertTenantFrontendConfigRequest,
} from './types';

const BASE = 'admin/tenants';

export function listTenants(params?: ListParams): Promise<Paginated<Tenant>> {
  return getJson(BASE, params);
}

/** Detail read keeping the ETag for the later PATCH. */
export function getTenant(id: string): Promise<WithEtag<Tenant>> {
  return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function getTenantByCodeName(codeName: string): Promise<WithEtag<Tenant>> {
  return getWithEtag(`${BASE}/code-name/${encodeURIComponent(codeName)}`);
}

export function listTenantsByUser(userId: string, params?: ListParams): Promise<Paginated<Tenant>> {
  return getJson(`${BASE}/user/${encodeURIComponent(userId)}`, params);
}

export function createTenant(body: CreateTenantRequest): Promise<Tenant> {
  return postJson(BASE, body);
}

/** Global-admin create-tenant-with-admin (never leaves a tenant adminless). */
export function provisionTenant(body: ProvisionTenantRequest): Promise<TenantProvisionResult> {
  return postJson(`${BASE}/provision`, body);
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. */
export async function updateTenant(id: string, patch: UpdateTenantRequest, etag: string): Promise<WithEtag<Tenant>> {
  return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Soft delete (the platform never hard-deletes). */
export function deleteTenant(id: string): Promise<Tenant> {
  return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}

export function suspendTenant(id: string): Promise<Tenant> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/suspend`);
}

export function archiveTenant(id: string): Promise<Tenant> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/archive`);
}

export function restoreTenant(id: string): Promise<Tenant> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/restore`);
}

/**
 * Reconcile this tenant's ASR pipeline catalog against the SYSTEM
 * templates. Global-admin only (`manage:Tenant`). Missing templates are cloned
 * in as locked copies and pristine locked copies are fast-forwarded; customized
 * (unlocked) pipelines are never touched. Idempotent.
 */
export function resyncTenantPipelineTemplates(id: string): Promise<PipelineResyncSummary> {
  return postJson(`${BASE}/${encodeURIComponent(id)}/pipelines/resync`);
}

export function getTenantUsage(id: string): Promise<TenantUsage> {
  return getJson(`${BASE}/${encodeURIComponent(id)}/usage`);
}

/**
 * TASK-959 — the per-class storage breakdown, beside the live `Media.size`
 * figure above. Reads `admin/usage/summary?tenantId=` rather than a
 * tenant-scoped path: that route is the one place the nightly snapshot's
 * per-class split exists (`UsageSummaryResponse.storage`), and it already
 * accepts a target tenant for a platform admin (a tenant admin viewing its
 * OWN tenant id passes the same scope check `resolveScopedTenantId` applies
 * to every other admin-usage read). No `period` is passed — the endpoint
 * defaults to the current UTC month, and the snapshot is a LEVEL (the
 * latest day), not a period sum, so which month is largely academic here.
 */
export function getTenantStorageBreakdown(id: string): Promise<{ storage: TenantStorageSnapshot | null }> {
  return getJson('admin/usage/summary', { tenantId: id });
}

export function getTenantTags(id: string): Promise<{ tags: string[] }> {
  return getJson(`${BASE}/${encodeURIComponent(id)}/tags`);
}

/**
 * OCC: `If-Match` is REQUIRED. The tag route writes the TENANT row, so the
 * validator is the tenant detail ETag (`GET admin/tenants/:id`), not anything
 * the `/tags` read returns. Drift is 412 — re-read the tenant and retry.
 */
export async function setTenantTags(id: string, tags: string[], etag: string): Promise<Tenant> {
  return (await putWithEtag<Tenant>(`${BASE}/${encodeURIComponent(id)}/tags`, { tags }, etag)).data;
}

/** identifier = tenant UUID or code-name (dual route). */
export function listTenantConfigs(identifier: string, params?: ListParams): Promise<Paginated<TenantConfig>> {
  return getJson(`${BASE}/configs/${encodeURIComponent(identifier)}`, params);
}

/** Bulk config update — per-row expectedVersion, all-or-nothing on drift. */
export function updateTenantConfigs(identifier: string, updates: UpdateTenantConfigItem[]): Promise<TenantConfig[]> {
  return patchJson(`${BASE}/configs/${encodeURIComponent(identifier)}`, updates);
}

/** Elevated admins target any tenant via ?tenantId=; tenant admins omit it. */
export function getFrontendConfig(tenantId?: string): Promise<WithEtag<TenantFrontendConfig | null>> {
  return getWithEtag('admin/tenant-frontend-config', { tenantId });
}

/** Upsert: pass the ETag when updating an existing row; omit on first write. */
export async function updateFrontendConfig(
  body: UpsertTenantFrontendConfigRequest,
  etag?: string,
  tenantId?: string,
): Promise<WithEtag<TenantFrontendConfig>> {
  return request('admin/tenant-frontend-config', { method: 'PUT', body, etag, params: { tenantId } });
}
