import { TenantBucketPurpose, TenantPlan } from '@arcaai/domains';
import {
  CreateTenantBucketRequest,
  DeleteTenantBucketObjectResponse,
  SetTenantBucketDefaultsRequest,
  TenantBucketDefaultsResponse,
  TenantBucketObjectResponse,
  TenantBucketPhysicalResponse,
  TenantBucketResponse,
  TenantBucketTreeResponse,
} from './dto';

export abstract class ITenantBucketService {
  abstract listBuckets(options?: { includeDisabled?: boolean }): Promise<TenantBucketResponse[]>;
  /**
   * "All tenants" storage-browser listing (TASK-932 Lane T): every registered
   * `TenantBucket` row across every tenant, merged with the physical bucket
   * list from the storage provider. Restricted to an unscoped SUPER_ADMIN (no
   * working tenant) — throws `BadRequestException` for any tenant-bound caller.
   */
  abstract listBucketsCrossTenantWithPhysical(): Promise<TenantBucketPhysicalResponse[]>;
  abstract getBucketById(id: string): Promise<TenantBucketResponse | null>;
  abstract getBucketTree(id: string, prefix?: string): Promise<TenantBucketTreeResponse>;
  abstract getBucketBySlug(slug: string): Promise<TenantBucketResponse | null>;
  abstract getBucketByName(name: string): Promise<TenantBucketResponse | null>;
  /** Resolve the tenant's default bucket for a logical purpose (AUDIO / ATTACHMENTS / MISC). */
  abstract getBucketByPurpose(purpose: TenantBucketPurpose): Promise<TenantBucketResponse | null>;
  abstract createCustomBucket(dto: CreateTenantBucketRequest): Promise<TenantBucketResponse>;
  abstract registerBucket(name: string, description?: string): Promise<TenantBucketResponse | null>;
  /**
   * Adopt an EXISTING physical bucket into an explicitly named tenant —
   * registry-only, the bucket itself is untouched. Unlike `registerBucket`
   * the owner is a parameter, because the storage browser's "All tenants"
   * view is an unscoped platform admin with no ambient tenant.
   *
   * Throws `BadRequestException` for a platform bucket or a name already
   * registered to a different tenant, and `NotFoundException` when the
   * tenant or the physical bucket does not exist.
   */
  abstract adoptPhysicalBucket(name: string, tenantId: string, description?: string): Promise<TenantBucketResponse>;
  abstract deleteBucket(id: string): Promise<TenantBucketResponse>;
  /** List objects in a tenant bucket via the storage provider (optionally under a prefix). */
  abstract listObjects(bucketId: string, prefix?: string): Promise<TenantBucketObjectResponse[]>;
  /** Upload a single object into a tenant bucket via the storage provider. */
  abstract uploadObject(bucketId: string, fileKey: string, body: Buffer, contentType?: string): Promise<TenantBucketObjectResponse>;
  /** Remove a single object from a tenant bucket via the storage provider. */
  abstract deleteObject(bucketId: string, fileKey: string): Promise<DeleteTenantBucketObjectResponse>;
  abstract provisionSystemBuckets(tenantId: string): Promise<TenantBucketResponse[]>;
  /**
   * Stamps the plan's `storageQuotaBytes` — ONE tenant-wide ceiling shared by
   * both system buckets (TASK-1025 G3) — onto the attachments AND recordings
   * rows as `TenantBucket.quotaBytes`, re-deriving any stamp that no longer
   * matches the plan; an unlimited plan clears it, a `null` plan is a no-op.
   * Display only: upload enforcement resolves the quota from the entitlements.
   */
  abstract applyPlanStorageQuota(tenantId: string, plan: TenantPlan | null): Promise<void>;
  /**
   * TASK-1025 G2 — the tenant is being soft-deleted: move each of its ENABLED
   * bucket rows to ARCHIVED (access cut, objects kept). Returns how many rows
   * were retained. Run under the TARGET tenant's CLS context.
   */
  abstract retainForTenantDeletion(tenantId: string): Promise<number>;
  /**
   * TASK-1025 G2 — the deleted tenant is being restored inside the retention
   * window: ARCHIVED rows go back to ENABLED. Buckets the purge has started on
   * or finished are NOT restored; `purged` counts them so the caller can say so.
   */
  abstract releaseTenantDeletionRetention(tenantId: string): Promise<{ restored: number; purged: number }>;
  /**
   * TASK-1025 OD-4 — read-only: how many of the deleted tenant's SYSTEM buckets
   * the purge has started on (SUSPENDED) or finished (DELETED). Any purged
   * bucket makes the tenant unrestorable. Run under the TARGET tenant's CLS context.
   */
  abstract countPurgedForTenantDeletion(tenantId: string): Promise<number>;
  abstract getPresignedUrl(bucketId: string, fileKey: string): Promise<{ url: string }>;
  /** Read the tenant's current default bucket per purpose. */
  abstract getDefaultBuckets(): Promise<TenantBucketDefaultsResponse>;
  /** (Re)assign which bucket serves each purpose; clears the purpose from prior holders. */
  abstract setDefaultBuckets(dto: SetTenantBucketDefaultsRequest): Promise<TenantBucketDefaultsResponse>;
}
