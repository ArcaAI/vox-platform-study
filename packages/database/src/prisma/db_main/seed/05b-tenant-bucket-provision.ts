/**
 * Provisions the physical MinIO buckets for every TenantBucket row
 * `seedTenantBucket` (05a) just wrote. That step is DB-rows-only by design;
 * without this step a fresh environment (dev or prod) has bucket rows with no
 * matching physical bucket, and every storage read 500s with `NoSuchBucket`.
 *
 * Reads bucket names from Postgres (not re-derived from `buildBucketName`) so
 * this stays correct even if 05a's naming ever changes. Idempotent: HeadBucket
 * before CreateBucket, safe to re-run on every deploy/seed.
 *
 * Skips silently (with a warning) when `MINIO_ENDPOINT` is unreachable, same
 * posture as the rest of `seed()` — storage is best-effort, DB rows are not.
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { CorePrismaClient } from '../../../client';

function makeS3Client(): S3Client {
  const endpointRaw = process.env.MINIO_ENDPOINT ?? 'localhost:9000';
  const useSsl = (process.env.MINIO_USE_SSL ?? 'false').toLowerCase() === 'true';
  const endpoint = /^https?:\/\//.test(endpointRaw) ? endpointRaw : `${useSsl ? 'https' : 'http'}://${endpointRaw}`;
  return new S3Client({
    endpoint,
    region: process.env.MINIO_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'minio_admin',
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'minio_admin',
    },
    forcePathStyle: true,
    maxAttempts: 2,
  });
}

async function ensureBucket(s3: S3Client, bucket: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return false;
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    return true;
  }
}

export const provisionTenantBuckets = async (client: CorePrismaClient): Promise<void> => {
  console.log('Provisioning physical MinIO buckets for tenant buckets...');

  const buckets = await client.tenantBucket.findMany({
    where: { resourceStatus: { not: 'DELETED' } },
    select: { name: true },
    distinct: ['name'],
  });

  const s3 = makeS3Client();
  let created = 0;
  try {
    for (const { name } of buckets) {
      const wasCreated = await ensureBucket(s3, name);
      if (wasCreated) created += 1;
    }
    console.log(`Provisioned ${created} new bucket(s), ${buckets.length - created} already existed (${buckets.length} total)`);
  } catch (error) {
    console.warn(`⚠️  Skipping MinIO bucket provisioning: ${error instanceof Error ? error.message : String(error)}.`);
  }
};
