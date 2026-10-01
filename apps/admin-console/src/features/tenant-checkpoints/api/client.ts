/** Tenant checkpoints API (`admin/tenants/:tenantId/checkpoints`). */

import { deleteJson, getJson, postJson } from '@/shared/api';
import type { ListParams, Paginated } from '@/shared/api';
import type {
  CompletedPart,
  CreateCheckpointRequest,
  DownloadUrl,
  InitUploadResult,
  RestoreRequest,
  TenantCheckpoint,
  TenantCheckpointRestore,
} from './types';

const base = (tenantId: string) => `admin/tenants/${encodeURIComponent(tenantId)}/checkpoints`;
const one = (tenantId: string, id: string) => `${base(tenantId)}/${encodeURIComponent(id)}`;

export function listCheckpoints(tenantId: string, params?: ListParams): Promise<Paginated<TenantCheckpoint>> {
  return getJson(base(tenantId), params);
}

export function getCheckpoint(tenantId: string, id: string): Promise<TenantCheckpoint> {
  return getJson(one(tenantId, id));
}

export function createCheckpoint(tenantId: string, body: CreateCheckpointRequest): Promise<TenantCheckpoint> {
  return postJson(base(tenantId), body);
}

export function cancelCheckpoint(tenantId: string, id: string): Promise<TenantCheckpoint> {
  return postJson(`${one(tenantId, id)}/cancel`);
}

export function getDownloadUrl(tenantId: string, id: string): Promise<DownloadUrl> {
  return postJson(`${one(tenantId, id)}/download-url`);
}

export function deleteCheckpoint(tenantId: string, id: string): Promise<void> {
  return deleteJson(one(tenantId, id));
}

export function initUpload(tenantId: string, body: { filename: string; sizeBytes: number }): Promise<InitUploadResult> {
  return postJson(`${base(tenantId)}/uploads`, body);
}

export function completeUpload(tenantId: string, uploadId: string, parts: CompletedPart[]): Promise<TenantCheckpoint> {
  return postJson(`${base(tenantId)}/uploads/${encodeURIComponent(uploadId)}/complete`, { parts });
}

export function abortUpload(tenantId: string, uploadId: string): Promise<TenantCheckpoint> {
  return postJson(`${base(tenantId)}/uploads/${encodeURIComponent(uploadId)}/abort`);
}

export function restoreCheckpoint(tenantId: string, id: string, body: RestoreRequest): Promise<TenantCheckpointRestore> {
  return postJson(`${one(tenantId, id)}/restore`, body);
}

export function listRestores(tenantId: string, params?: ListParams): Promise<Paginated<TenantCheckpointRestore>> {
  return getJson(`${base(tenantId)}/restores`, params);
}

export function getRestore(tenantId: string, restoreId: string): Promise<TenantCheckpointRestore> {
  return getJson(`${base(tenantId)}/restores/${encodeURIComponent(restoreId)}`);
}
