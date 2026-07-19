/**
 * Tenant Bucket Seed
 *
 * Provisions the TWO default system bucket DB rows for every seeded tenant
 * (TASK-426):
 *   - `attachments` — files uploaded by users while working (consultation
 *     documents, lab results, any files).
 *   - `recordings`  — audio recordings captured during live transcription
 *     (raw pre-normalization and processed post-normalization). Replaces the
 *     legacy `audio` slug but keeps the AUDIO purpose so streaming/batch
 *     bucket resolution is unchanged.
 *
 * Note: Only the DB rows are created here. The seed pipeline's next step
 * (`05b-tenant-bucket-provision.ts`) provisions the matching physical MinIO
 * buckets. The underlying provider bucket is also created lazily by the
 * storage flow (`TenantBucketService` provisions missing physical buckets on
 * demand and in `provisionSystemBuckets`) or via the admin endpoint
 * `POST /admin/tenants/storage/buckets/provision/:tenantId` as a fallback.
 *
 * Convergence for environments seeded before TASK-426:
 *   - a legacy `audio` row is RENAMED to `recordings` in place (id preserved so
 *     `Media.bucketId` references stay valid); if a `recordings` row already
 *     exists the redundant `audio` SYSTEM row is soft-deleted instead so at
 *     most one ENABLED bucket holds the AUDIO purpose;
 *   - legacy `misc` SYSTEM rows are soft-deleted (no longer a default bucket).
 */
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_USER_ID } from './00-constants';
import { ALL_TENANTS } from './05-tenant';

export const SYSTEM_BUCKET_SLUGS = {
  ATTACHMENTS: 'attachments',
  RECORDINGS: 'recordings',
  MISC: 'misc',
} as const;

const LEGACY_AUDIO_SLUG = 'audio';

const SYSTEM_BUCKET_DESCRIPTIONS: Record<string, string> = {
  [SYSTEM_BUCKET_SLUGS.ATTACHMENTS]: 'Tenant attachment storage (consultation documents, lab results, user-uploaded files)',
  [SYSTEM_BUCKET_SLUGS.RECORDINGS]: 'Tenant audio recordings from live transcription (raw and processed)',
  [SYSTEM_BUCKET_SLUGS.MISC]: 'Tenant misc assets (background, avatars, images)',
};

const SYSTEM_BUCKET_PATH_PATTERNS: Record<string, string> = {
  [SYSTEM_BUCKET_SLUGS.ATTACHMENTS]: '{yyyy}/{MM}/{dd}',
  [SYSTEM_BUCKET_SLUGS.RECORDINGS]: '{yyyy}/{MM}',
  [SYSTEM_BUCKET_SLUGS.MISC]: '{category}',
};

const SYSTEM_BUCKET_PURPOSES: Record<string, 'AUDIO' | 'ATTACHMENTS' | 'MISC'> = {
  [SYSTEM_BUCKET_SLUGS.ATTACHMENTS]: 'ATTACHMENTS',
  [SYSTEM_BUCKET_SLUGS.RECORDINGS]: 'AUDIO',
  [SYSTEM_BUCKET_SLUGS.MISC]: 'MISC',
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

/**
 * Converge legacy rows for one tenant (idempotent):
 * rename `audio` → `recordings` when possible, otherwise soft-delete the
 * redundant `audio` row; soft-delete the `misc` SYSTEM row.
 */
async function convergeLegacyBuckets(client: CorePrismaClient, tenant: { id: string; key: string }): Promise<void> {
  const [legacyAudio, recordings] = await Promise.all([
    client.tenantBucket.findUnique({
      where: { TenantBucket_tenant_slug_unique: { tenantId: tenant.id, slug: LEGACY_AUDIO_SLUG } },
    }),
    client.tenantBucket.findUnique({
      where: { TenantBucket_tenant_slug_unique: { tenantId: tenant.id, slug: SYSTEM_BUCKET_SLUGS.RECORDINGS } },
    }),
  ]);

  if (legacyAudio && !recordings) {
    // In-place rename preserves the row id (Media.bucketId references stay valid).
    await client.tenantBucket.update({
      where: { id: legacyAudio.id },
      data: {
        slug: SYSTEM_BUCKET_SLUGS.RECORDINGS,
        name: buildBucketName(tenant.key, SYSTEM_BUCKET_SLUGS.RECORDINGS),
        updatedBy: SYSTEM_USER_ID,
        version: { increment: 1 },
      },
    });
    console.log(`  Converged legacy 'audio' bucket → 'recordings' for tenant ${tenant.key}`);
  } else if (legacyAudio && recordings && legacyAudio.resourceStatus !== 'DELETED') {
    // Both exist (partial previous convergence): keep `recordings` as the sole
    // ENABLED AUDIO-purpose bucket and retire the legacy row.
    await client.tenantBucket.update({
      where: { id: legacyAudio.id },
      data: {
        resourceStatus: 'DELETED',
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: SYSTEM_USER_ID,
        updatedBy: SYSTEM_USER_ID,
        version: { increment: 1 },
      },
    });
    console.log(`  Soft-deleted redundant legacy 'audio' bucket for tenant ${tenant.key}`);
  }
}

export const seedTenantBucket = async (client: CorePrismaClient): Promise<void> => {
  console.log('Seeding tenant buckets...');
  try {
    let upsertCount = 0;
    for (const tenant of ALL_TENANTS) {
      await convergeLegacyBuckets(client, tenant);

      for (const slug of Object.values(SYSTEM_BUCKET_SLUGS)) {
        const name = buildBucketName(tenant.key, slug);
        const description = SYSTEM_BUCKET_DESCRIPTIONS[slug] ?? null;
        const pathPattern = SYSTEM_BUCKET_PATH_PATTERNS[slug] ?? '{yyyy}/{MM}/{dd}/{user_name}';
        const purpose = SYSTEM_BUCKET_PURPOSES[slug] ?? 'CUSTOM';
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
            purpose,
            pathPattern,
          },
          update: {
            name,
            description,
            purpose,
            pathPattern,
            // System defaults are always available: revive a previously
            // soft-deleted default row instead of leaving the tenant without it.
            resourceStatus: 'ENABLED',
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
