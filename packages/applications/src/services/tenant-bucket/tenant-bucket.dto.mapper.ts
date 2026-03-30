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
      pathPattern: entity.pathPattern,
      isSystemBucket: entity.isSystemBucket,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
