/**
 * Wire types for the tenant storage DATA plane (frame 31), mirroring
 * apps/api/src/modules/storage/storage.controller.ts + its dto/ folder.
 * Distinct from features/storage (the tier-14 admin plane under
 * /admin/tenants/storage): these routes address PHYSICAL buckets by name.
 */

/** GET /storage/buckets rows (BucketInfoResponse) — a plain array, not paginated. */
export interface StorageBucket {
  name: string;
  creationDate?: string;
}

/**
 * GET /storage/buckets?includePhysical=true rows (TASK-932 Lane T) — the
 * storage browser "All tenants" view for an unscoped platform admin (no
 * working tenant): every tenant's registered buckets merged with the
 * physical bucket list from the provider. `tenantId`/`tenantName` are null
 * for an unregistered physical bucket.
 */
export interface StorageBucketWithScope extends StorageBucket {
  tenantId: string | null;
  tenantName: string | null;
  registered: boolean;
  physicalMissing: boolean;
}

/** POST /storage/buckets body (CreateBucketRequest). */
export interface CreateBucketRequest {
  name: string;
  type?: string;
}

/** POST /storage/buckets response (CreateBucketResponse). */
export interface CreateBucketResult {
  name: string;
  created: boolean;
}

/** PATCH /storage/buckets/:name body (UpdateBucketRequest — S3 metadata tags). */
export interface UpdateBucketRequest {
  description?: string;
  resourceStatus?: string;
}

/** PATCH /storage/buckets/:name response (UpdateBucketResponse). */
export interface UpdateBucketResult {
  name: string;
  description?: string;
  resourceStatus?: string;
}

/** DELETE /storage/buckets/:name response (DeleteBucketResponse). */
export interface DeleteBucketResult {
  name: string;
  deleted: boolean;
}

/**
 * Objects as listed by GET /storage/buckets/:name/files (BlobObjectSummary on
 * the gateway). The route returns a PLAIN ARRAY — no count envelope and no
 * pagination params (prefix is the only filter), so paging is client-side.
 */
export interface StorageObject {
  key: string;
  size: number;
  lastModified?: string;
}

/** GET /storage/buckets/:name response (BucketWithFilesResponse). */
export interface BucketWithFiles {
  name: string;
  files: StorageObject[];
}

/** POST /storage/buckets/:name/files response (FileUploadResponse). */
export interface FileUploadResult {
  key: string;
  size: number;
  contentType: string;
  mediaId?: string;
}

/** GET /storage/buckets/:name/files/:key response — presigned URL JSON, not bytes. */
export interface FileInfoResult {
  key: string;
  url: string;
}

/** DELETE /storage/buckets/:name/files/:key response (DeleteFileResponse). */
export interface DeleteFileResult {
  deleted: boolean;
  key: string;
}

/** GET /storage/health response (S3HealthService projection). */
export interface StorageHealth {
  status: 'healthy' | 'unhealthy' | 'not-configured';
  connected: boolean;
  isMinIO: boolean;
  configured?: boolean;
  endpoint?: string;
  publicBucket?: string;
  privateBucket?: string;
  error?: string;
}
