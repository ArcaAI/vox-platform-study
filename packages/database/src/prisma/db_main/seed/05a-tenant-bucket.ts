/**
 * Tenant Bucket Seed
 *
 * Provisions the default system bucket DB rows for every seeded tenant.
 *
 * Note: Only the DB rows are created here. The underlying S3 buckets are created
 * lazily by the storage flow (see `tenantBucketService.provisionSystemBuckets`)
 * or via the admin endpoint
 * `POST /admin/tenants/storage/buckets/provision/:tenantId`.
 */
import type { CorePrismaClient } from '../../../client';
import { ALL_TENANTS } from './05-tenant';

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
  return `hope-${sanitizeBucketName(slug)}-${sanitizeBucketName(tenantKey)}`;
}

export const seedTenantBucket = async (client: CorePrismaClient): Promise<void> => {
  console.log('Seeding tenant buckets...');
  try {
    let upsertCount = 0;
    for (const tenant of ALL_TENANTS) {
      for (const slug of Object.values(SYSTEM_BUCKET_SLUGS)) {
        const name = buildBucketName(tenant.key, slug);
        const description = SYSTEM_BUCKET_DESCRIPTIONS[slug] ?? null;
        const pathPattern = SYSTEM_BUCKET_PATH_PATTERNS[slug] ?? '{yyyy}/{MM}/{dd}/{user_name}';
        await client.tenantBucket.upsert({
          where: {
            TenantBucket_tenant_slug_unique: {
              tenantId: tenant.id,
              slug,
            },
          },
          create: {
            tenantId: tenant.id,
            name,
            slug,
            description,
            bucketType: 'SYSTEM',
            pathPattern,
          },
          update: {
            name,
            description,
            pathPattern,
          },
        });
        upsertCount += 1;
      }
    }
    console.log(`Seeded ${upsertCount} tenant bucket(s) across ${ALL_TENANTS.length} tenant(s)`);
  } catch (error) {
    console.error('Error seeding tenant buckets:', error);
    throw error;
  }
};
