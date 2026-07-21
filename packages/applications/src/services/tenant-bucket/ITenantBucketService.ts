import { TenantBucketPurpose, TenantPlan } from '@arcaai/domains';
import {
  CreateTenantBucketRequest,
  DeleteTenantBucketObjectResponse,
  SetTenantBucketDefaultsRequest,
  TenantBucketDefaultsResponse,
  TenantBucketObjectResponse,
  TenantBucketResponse,
  TenantBucketTreeResponse,
} from './dto';

export abstract class ITenantBucketService {
  abstract listBuckets(options?: { includeDisabled?: boolean }): Promise<TenantBucketResponse[]>;
  abstract getBucketById(id: string): Promise<TenantBucketResponse | null>;
  abstract getBucketTree(id: string, prefix?: string): Promise<TenantBucketTreeResponse>;
  abstract getBucketBySlug(slug: string): Promise<TenantBucketResponse | null>;
  abstract getBucketByName(name: string): Promise<TenantBucketResponse | null>;
  /** Resolve the tenant's default bucket for a logical purpose (AUDIO / ATTACHMENTS / MISC). */
  abstract getBucketByPurpose(purpose: TenantBucketPurpose): Promise<TenantBucketResponse | null>;
  abstract createCustomBucket(dto: CreateTenantBucketRequest): Promise<TenantBucketResponse>;
  abstract registerBucket(name: string, description?: string): Promise<TenantBucketResponse | null>;
  abstract deleteBucket(id: string): Promise<TenantBucketResponse>;
  /** List objects in a tenant bucket via the storage provider (optionally under a prefix). */
  abstract listObjects(bucketId: string, prefix?: string): Promise<TenantBucketObjectResponse[]>;
  /** Upload a single object into a tenant bucket via the storage provider. */
  abstract uploadObject(bucketId: string, fileKey: string, body: Buffer, contentType?: string): Promise<TenantBucketObjectResponse>;
  /** Remove a single object from a tenant bucket via the storage provider. */
  abstract deleteObject(bucketId: string, fileKey: string): Promise<DeleteTenantBucketObjectResponse>;
  abstract provisionSystemBuckets(tenantId: string): Promise<TenantBucketResponse[]>;
  /**
   * Writes the plan's `PlanEntitlement.storageQuotaBytes` onto the tenant's
   * primary (AUDIO) system bucket as `TenantBucket.quotaBytes`.
   * Idempotent — only writes when the bucket's `quotaBytes` is currently
   * null; a `null` plan or a `null` storageQuotaBytes (unlimited tier) is a
   * no-op that leaves `quotaBytes` null.
   */
  abstract applyPlanStorageQuota(tenantId: string, plan: TenantPlan | null): Promise<void>;
  abstract getPresignedUrl(bucketId: string, fileKey: string): Promise<{ url: string }>;
  /** Read the tenant's current default bucket per purpose. */
  abstract getDefaultBuckets(): Promise<TenantBucketDefaultsResponse>;
  /** (Re)assign which bucket serves each purpose; clears the purpose from prior holders. */
  abstract setDefaultBuckets(dto: SetTenantBucketDefaultsRequest): Promise<TenantBucketDefaultsResponse>;
}
