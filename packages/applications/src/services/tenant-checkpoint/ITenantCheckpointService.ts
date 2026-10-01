import type {
  CheckpointDownloadUrlResponse,
  CompleteCheckpointUploadRequest,
  CreateCheckpointRequest,
  InitCheckpointUploadRequest,
  InitCheckpointUploadResponse,
  ListCheckpointsQuery,
  ListRestoresQuery,
  PaginatedTenantCheckpointResponse,
  PaginatedTenantCheckpointRestoreResponse,
  RestoreCheckpointRequest,
  TenantCheckpointResponse,
  TenantCheckpointRestoreResponse,
} from './dto';

/**
 * Every method takes the target tenant id and first refuses the SYSTEM tenant. Row lookups are
 * pinned to that tenant: a row of another tenant is `NotFound`, never `Forbidden`.
 */
export interface ITenantCheckpointService {
  create(tenantId: string, request: CreateCheckpointRequest): Promise<TenantCheckpointResponse>;
  list(tenantId: string, query: ListCheckpointsQuery): Promise<PaginatedTenantCheckpointResponse>;
  get(tenantId: string, checkpointId: string): Promise<TenantCheckpointResponse>;
  cancel(tenantId: string, checkpointId: string): Promise<TenantCheckpointResponse>;
  downloadUrl(tenantId: string, checkpointId: string): Promise<CheckpointDownloadUrlResponse>;
  delete(tenantId: string, checkpointId: string): Promise<void>;
  initUpload(tenantId: string, request: InitCheckpointUploadRequest): Promise<InitCheckpointUploadResponse>;
  /** `uploadRef` is the multipart upload id returned by `initUpload` (the checkpoint id is accepted too). */
  completeUpload(tenantId: string, uploadRef: string, request: CompleteCheckpointUploadRequest): Promise<TenantCheckpointResponse>;
  abortUpload(tenantId: string, uploadRef: string): Promise<TenantCheckpointResponse>;
  restore(tenantId: string, checkpointId: string, request: RestoreCheckpointRequest): Promise<TenantCheckpointRestoreResponse>;
  listRestores(tenantId: string, query: ListRestoresQuery): Promise<PaginatedTenantCheckpointRestoreResponse>;
  getRestore(tenantId: string, restoreId: string): Promise<TenantCheckpointRestoreResponse>;
}
export const ITenantCheckpointService = Symbol('ITenantCheckpointService');
