import { TenantBucketEntity } from '@arcaai/domains';
import { TenantBucketResponse } from './dto';

export class TenantBucketDtoMapper {
  static toResponse(entity: TenantBucketEntity): TenantBucketResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId as string,
      name: entity.name,
      slug: entity.slug,
      description: entity.description ?? undefined,
      bucketType: entity.bucketType,
      purpose: entity.purpose,
      pathPattern: entity.pathPattern,
      isSystemBucket: entity.isSystemBucket,
      // TASK-407 — BigInt is not JSON-serializable; quotas are well below 2^53.
      quotaBytes: entity.quotaBytes != null ? Number(entity.quotaBytes) : null,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
