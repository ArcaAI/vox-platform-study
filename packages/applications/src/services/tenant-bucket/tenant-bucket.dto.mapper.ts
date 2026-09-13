// `import type` on purpose: a VALUE import here pulls the whole
// `@arcaai/domains` barrel (Prisma included) into every module that imports
// this mapper. Keep the mapper a leaf — `platform` comes off the entity.
import type { TenantBucketEntity } from '@arcaai/domains';
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
      // TASK-967 — derived from the NAME by the entity, not stored. The console
      // cannot classify a bucket itself, and it must tell a PLATFORM bucket
      // apart from the SYSTEM tenant's own `hope-attachments-system` — both are
      // SYSTEM-tenant rows stamped SYSTEM, but only the former is deletable,
      // and only by a platform admin.
      platform: entity.isPlatformBucket,
      // BigInt is not JSON-serializable; quotas are well below 2^53.
      quotaBytes: entity.quotaBytes != null ? Number(entity.quotaBytes) : null,
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
