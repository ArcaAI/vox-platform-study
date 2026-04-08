import { CreateTenantBucketRequest, TenantBucketResponse, TenantBucketTreeResponse } from './dto';

export abstract class ITenantBucketService {
  abstract listBuckets(options?: { includeDisabled?: boolean }): Promise<TenantBucketResponse[]>;
  abstract getBucketById(id: string): Promise<TenantBucketResponse | null>;
  abstract getBucketTree(id: string, prefix?: string): Promise<TenantBucketTreeResponse>;
  abstract getBucketBySlug(slug: string): Promise<TenantBucketResponse | null>;
  abstract getBucketByName(name: string): Promise<TenantBucketResponse | null>;
  abstract createCustomBucket(dto: CreateTenantBucketRequest): Promise<TenantBucketResponse>;
  abstract deleteBucket(id: string): Promise<TenantBucketResponse>;
  abstract provisionSystemBuckets(tenantId: string): Promise<TenantBucketResponse[]>;
  abstract getPresignedUrl(bucketId: string, fileKey: string): Promise<{ url: string }>;
}
