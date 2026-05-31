import { TenantBucketEntity } from '../../../entities/generated/core/TenantBucketEntity';
import { TenantBucketPurpose, TenantBucketType } from '../../../enums';
import { generateId } from '../../../utils';

export const SYSTEM_BUCKET_SLUGS = {
  AUDIO: 'audio',
  ATTACHMENTS: 'attachments',
  MISC: 'misc',
} as const;

const SYSTEM_BUCKET_DESCRIPTIONS: Record<string, string> = {
  [SYSTEM_BUCKET_SLUGS.AUDIO]: 'Tenant audio storage (streaming and batch jobs)',
  [SYSTEM_BUCKET_SLUGS.ATTACHMENTS]: 'Tenant attachment storage (consultation files)',
  [SYSTEM_BUCKET_SLUGS.MISC]: 'Tenant misc assets (background, avatars, images)',
};

const SYSTEM_BUCKET_PATH_PATTERNS: Record<string, string> = {
  [SYSTEM_BUCKET_SLUGS.AUDIO]: '{yyyy}/{MM}',
  [SYSTEM_BUCKET_SLUGS.ATTACHMENTS]: '{yyyy}/{MM}/{dd}',
  [SYSTEM_BUCKET_SLUGS.MISC]: '{category}',
};

/** Logical purpose for each system bucket slug (drives `findByPurpose` resolution). */
const SYSTEM_BUCKET_PURPOSES: Record<string, TenantBucketPurpose> = {
  [SYSTEM_BUCKET_SLUGS.AUDIO]: TenantBucketPurpose.AUDIO,
  [SYSTEM_BUCKET_SLUGS.ATTACHMENTS]: TenantBucketPurpose.ATTACHMENTS,
  [SYSTEM_BUCKET_SLUGS.MISC]: TenantBucketPurpose.MISC,
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
      purpose: SYSTEM_BUCKET_PURPOSES[slug] ?? TenantBucketPurpose.CUSTOM,
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
      purpose: TenantBucketPurpose.CUSTOM,
      pathPattern: pathPattern ?? '{yyyy}/{MM}/{dd}/{user_name}',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: createdBy ?? null,
      updatedBy: null,
    });
  }

  /**
   * Create a CUSTOM bucket whose physical S3 name is supplied verbatim
   * (rather than derived from `tenantKey`+`slug`). Used by the storage
   * controller's `POST /storage/buckets`, where the caller names the S3
   * bucket directly and the DB row must mirror that exact name so the
   * bucket is addressable by name on the GET/PATCH/DELETE routes.
   *
   * The slug is sanitized from the name to satisfy the per-tenant
   * `(tenantId, slug)` uniqueness constraint; `name` is globally unique
   * (matching the S3 namespace).
   */
  static CreateNamedBucket(tenantId: string, name: string, description?: string, createdBy?: string): TenantBucketEntity {
    return new TenantBucketEntity({
      id: generateId(),
      tenantId,
      name,
      slug: sanitizeBucketName(name),
      description: description ?? null,
      bucketType: TenantBucketType.CUSTOM,
      purpose: TenantBucketPurpose.CUSTOM,
      pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
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
      this.CreateSystemBucket(tenantId, tenantKey, SYSTEM_BUCKET_SLUGS.MISC, undefined, createdBy),
    ];
  }
}
