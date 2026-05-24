import { TenantBucketEntity } from '../../../entities/generated/core/TenantBucketEntity';
import { TenantBucketType } from '../../../enums';
import { generateId } from '../../../utils';

export const SYSTEM_BUCKET_SLUGS = {
  AUDIO: 'audio',
  ATTACHMENTS: 'attachments',
} as const;

const SYSTEM_BUCKET_DESCRIPTIONS: Record<string, string> = {
  [SYSTEM_BUCKET_SLUGS.AUDIO]: 'Tenant audio storage (streaming and batch jobs)',
  [SYSTEM_BUCKET_SLUGS.ATTACHMENTS]: 'Tenant attachment storage (consultation files)',
};

const SYSTEM_BUCKET_PATH_PATTERNS: Record<string, string> = {
  [SYSTEM_BUCKET_SLUGS.AUDIO]: '{yyyy}/{MM}',
  [SYSTEM_BUCKET_SLUGS.ATTACHMENTS]: '{yyyy}/{MM}/{dd}',
};

function sanitizeBucketName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildBucketName(tenantKey: string, slug: string): string {
  const sanitizedKey = sanitizeBucketName(tenantKey);
  const sanitizedSlug = sanitizeBucketName(slug);
  return `hope-${sanitizedSlug}-${sanitizedKey}`;
}

export class TenantBucketFactory {
  static CreateSystemBucket(tenantId: string, tenantKey: string, slug: string, description?: string, createdBy?: string): TenantBucketEntity {
    return new TenantBucketEntity({
      id: generateId(),
      tenantId,
      name: buildBucketName(tenantKey, slug),
      slug,
      description: description ?? SYSTEM_BUCKET_DESCRIPTIONS[slug] ?? null,
      bucketType: TenantBucketType.SYSTEM,
      pathPattern: SYSTEM_BUCKET_PATH_PATTERNS[slug] ?? '{yyyy}/{MM}/{dd}/{user_name}',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: createdBy ?? null,
      updatedBy: null,
    });
  }

  static CreateCustomBucket(
    tenantId: string,
    tenantKey: string,
    slug: string,
    description?: string,
    createdBy?: string,
    pathPattern?: string,
  ): TenantBucketEntity {
    return new TenantBucketEntity({
      id: generateId(),
      tenantId,
      name: buildBucketName(tenantKey, slug),
      slug,
      description: description ?? null,
      bucketType: TenantBucketType.CUSTOM,
      pathPattern: pathPattern ?? '{yyyy}/{MM}/{dd}/{user_name}',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: createdBy ?? null,
      updatedBy: null,
    });
  }

  static CreateDefaultSystemBuckets(tenantId: string, tenantKey: string, createdBy?: string): TenantBucketEntity[] {
    return [
      this.CreateSystemBucket(tenantId, tenantKey, SYSTEM_BUCKET_SLUGS.AUDIO, undefined, createdBy),
      this.CreateSystemBucket(tenantId, tenantKey, SYSTEM_BUCKET_SLUGS.ATTACHMENTS, undefined, createdBy),
    ];
  }
}
