import type { ResourceStatus } from '@/shared/api';

export type TenantBucketType = 'SYSTEM' | 'CUSTOM';
export type TenantBucketPurpose = 'AUDIO' | 'ATTACHMENTS' | 'MISC' | 'CUSTOM';
export type StorageProviderType = 'MINIO' | 'AWS_S3' | 'AZURE_BLOB';
export type StorageTopologyType = 'SHARED' | 'DEDICATED';

/** GET /admin/tenants/storage/buckets rows (TenantBucketResponse). */
export interface TenantBucket {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  description?: string;
  bucketType: TenantBucketType;
  purpose: TenantBucketPurpose;
  pathPattern: string;
  isSystemBucket: boolean;
  quotaBytes?: number | null;
  resourceStatus?: ResourceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBucketRequest {
  slug: string;
  description?: string;
  pathPattern?: string;
}

/**
 * POST .../buckets/register — adopt an EXISTING physical bucket into a tenant.
 * Registry-only; the bucket itself is untouched. `tenantId` is explicit
 * because the storage browser view that surfaces adoptable buckets runs as an
 * unscoped platform admin with no working tenant to inherit.
 */
export interface AdoptBucketRequest {
  name: string;
  tenantId: string;
  description?: string;
}

/** GET/PUT .../buckets/defaults. */
export interface BucketDefaults {
  audio: TenantBucket | null;
  attachments: TenantBucket | null;
  misc: TenantBucket | null;
}

export interface SetBucketDefaultsRequest {
  audioBucketId?: string;
  attachmentsBucketId?: string;
  miscBucketId?: string;
}

export interface BucketObject {
  key: string;
  size: number;
  lastModified?: string;
}

export interface BucketTree {
  bucketId: string;
  bucketName: string;
  rootPath: string;
  nodes: BucketTreeNode[];
}

export interface BucketTreeNode {
  id: string;
  name: string;
  type: 'folder' | 'file';
  path: string;
  size?: number;
  lastModified?: string;
  children?: BucketTreeNode[];
}

/** GET/PUT /admin/tenants/storage/config rows (TenantStorageConfigResponse). */
export interface TenantStorageConfig {
  id: string;
  tenantId: string;
  bucketId?: string | null;
  provider: StorageProviderType;
  topology: StorageTopologyType;
  endpoint?: string | null;
  region?: string | null;
  forcePathStyle?: boolean | null;
  accountName?: string | null;
  endpointSuffix?: string | null;
  containerPrefix?: string | null;
  credentialsRef?: string | null;
  resourceStatus?: ResourceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertStorageConfigRequest {
  bucketId?: string | null;
  provider: StorageProviderType;
  topology?: StorageTopologyType;
  endpoint?: string | null;
  region?: string | null;
  forcePathStyle?: boolean | null;
  accountName?: string | null;
  endpointSuffix?: string | null;
  containerPrefix?: string | null;
  credentialsRef?: string | null;
}

/** GET /admin/tenants/storage/keys rows (StorageAccessKeyResponse). */
export interface StorageAccessKey {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  accessKeyId: string;
  permissions: string[];
  bucketIds: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

/** POST create returns the secret exactly once. */
export interface StorageAccessKeyWithSecret extends StorageAccessKey {
  secretAccessKey: string;
}

export interface CreateAccessKeyRequest {
  name: string;
  description?: string;
  permissions?: string[];
  bucketIds?: string[];
  expiresAt?: string;
}
