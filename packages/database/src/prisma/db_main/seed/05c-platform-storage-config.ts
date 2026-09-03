/**
 * Platform-Default Storage Config Seed
 *
 * Creates the ONE row that makes the platform object-store configuration
 * admin-managed data rather than deploy-time env: the SYSTEM-tenant
 * `TenantStorageConfig` with `bucketId = NULL`. It is the third step of the
 * resolution order the model already declares —
 * `bucket row → tenant default → SYSTEM default → env` — and the step that was
 * missing.
 *
 * BEHAVIOUR ON UPGRADE IS UNCHANGED: the seeded values are exactly today's
 * `MINIO_*` dev defaults (`localhost:9000`, `us-east-1`, path-style on), so a
 * platform that previously resolved storage from env resolves the identical
 * configuration from this row.
 *
 * CREDENTIALS ARE NOT SEEDED and never enter the database. The row records only
 * `credentialsRef` — a Vault kv-v2 PATH. Until an operator writes
 * `{ "accessKeyId": ..., "secretAccessKey": ... }` there, the runtime falls back
 * to the pre-existing `S3_ACCESS_KEY` / `S3_SECRET_KEY` secrets, which is what
 * keeps a dev box (`SECRETS_PROVIDER=env`) working with no extra setup.
 *
 * Idempotent. CREATE-ONLY: an existing row is left untouched, because after the
 * first boot it is the super admin's to edit, and a re-seed must never silently
 * revert an operator's change. Duplicate tenant-wide defaults are pruned (the
 * `@@unique([tenantId, bucketId])` index cannot enforce uniqueness across NULLs —
 * Postgres treats NULLs as distinct — so uniqueness is an application-layer rule
 * this seed also honours).
 */
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/** Stable id so a re-seed and a manual inspection can both find the row. */
export const PLATFORM_STORAGE_CONFIG_ID = '00000000-0000-0000-0005-000000000001';

/**
 * Vault kv-v2 path holding the platform storage credentials JSON.
 * Mirrors `PLATFORM_STORAGE_CREDENTIALS_REF` in
 * `packages/applications/src/services/tenant-storage-config/platform-storage-config.ts`.
 */
export const PLATFORM_STORAGE_CREDENTIALS_REF = 'platform/storage/minio';

/**
 * The platform storage endpoint as the running environment declares it:
 * `MINIO_ENDPOINT` (+ `MINIO_USE_SSL` for the scheme when the value carries none),
 * falling back to the local-dev `http://localhost:9000`. Shared with the
 * `S3_ENDPOINT` GlobalSetting seed (`06-stt.ts`) so the two rows the gateway reads
 * can never disagree — in-cluster they did: the setting was hardcoded to
 * `http://localhost:<port>`, so the S3 client dialled nothing and every governed
 * consultation fell back to the default loop).
 */
export function platformStorageEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MINIO_ENDPOINT?.trim() || 'localhost:9000';
  const useSsl = (env.MINIO_USE_SSL ?? 'false').trim().toLowerCase() === 'true';
  return /^https?:\/\//i.test(raw) ? raw : `${useSsl ? 'https' : 'http'}://${raw}`;
}

/** Today's `MINIO_*` dev defaults, expressed as the row's values. */
function platformDefaults(): {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
} {
  return {
    endpoint: platformStorageEndpoint(),
    region: (process.env.MINIO_REGION ?? 'us-east-1').trim(),
    forcePathStyle: true,
  };
}

export const seedPlatformStorageConfig = async (client: CorePrismaClient): Promise<void> => {
  console.log('Seeding platform-default storage config...');
  try {
    const existing = await client.tenantStorageConfig.findMany({
      where: { tenantId: SYSTEM_TENANT_ID, bucketId: null, resourceStatus: { not: 'DELETED' } },
      orderBy: { createdAt: 'asc' },
    });

    if (existing.length > 0) {
      // Application-layer uniqueness: retire any extra tenant-wide default so
      // exactly one ENABLED row remains (keep the oldest — it is the one the
      // resolver has been serving).
      const [keep, ...duplicates] = existing;
      if (duplicates.length > 0) {
        await client.tenantStorageConfig.updateMany({
          where: { id: { in: duplicates.map((row) => row.id) } },
          data: {
            resourceStatus: 'DELETED',
            resourceStatusUpdatedAt: new Date(),
            resourceStatusUpdatedBy: SYSTEM_USER_ID,
            updatedBy: SYSTEM_USER_ID,
            version: { increment: 1 },
          },
        });
        console.log(`  Retired ${duplicates.length} duplicate platform-default storage row(s)`);
      }
      console.log(`Platform-default storage config already present (id=${keep!.id}) — left untouched (operator-owned)`);
      return;
    }

    const defaults = platformDefaults();
    await client.tenantStorageConfig.create({
      data: {
        id: PLATFORM_STORAGE_CONFIG_ID,
        tenantId: SYSTEM_TENANT_ID,
        bucketId: null,
        provider: 'MINIO',
        topology: 'SHARED',
        endpoint: defaults.endpoint,
        region: defaults.region,
        forcePathStyle: defaults.forcePathStyle,
        // A Vault PATH, never credentials.
        credentialsRef: PLATFORM_STORAGE_CREDENTIALS_REF,
        createdBy: SYSTEM_USER_ID,
      },
    });

    console.log(`Seeded platform-default storage config (provider=MINIO, endpoint=${defaults.endpoint}, region=${defaults.region})`);
  } catch (error) {
    console.error('Error seeding platform-default storage config:', error);
    throw error;
  }
};
