import { TenantBucketPurpose } from '@arcaai/domains';
import {
  CreateTenantBucketRequest,
  DeleteTenantBucketObjectResponse,
  SetTenantBucketDefaultsRequest,
  TenantBucketDefaultsResponse,
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
  /** Remove a single object from a tenant bucket via the storage provider. */
  abstract deleteObject(bucketId: string, fileKey: string): Promise<DeleteTenantBucketObjectResponse>;
  abstract provisionSystemBuckets(tenantId: string): Promise<TenantBucketResponse[]>;
  abstract getPresignedUrl(bucketId: string, fileKey: string): Promise<{ url: string }>;
  /** Read the tenant's current default bucket per purpose. */
  abstract getDefaultBuckets(): Promise<TenantBucketDefaultsResponse>;
  /** (Re)assign which bucket serves each purpose; clears the purpose from prior holders. */
  abstract setDefaultBuckets(dto: SetTenantBucketDefaultsRequest): Promise<TenantBucketDefaultsResponse>;
}
