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
 * TASK-1025 G1 — failures are REPORTED, never hidden. Every bucket is tried
 * independently; each one that could not be made is named on stderr in a
 * summary, and the tally is returned. The step still does not THROW (a storage
 * outage must not wedge a seed run / deploy), so read the summary: a failed
 * bucket here is a row with no physical bucket behind it until the gateway's
 * `POST admin/tenant-buckets/provision/:tenantId` or on-demand create repairs it.
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { CorePrismaClient } from '../../../client';

/**
 * `??` is not enough here: `MINIO_ENDPOINT` ships BLANK in `.env.dev` (it is a
 * pre-seed bootstrap fallback), so `process.env.MINIO_ENDPOINT ?? default`
 * yields `''` and the endpoint becomes a bare `http://` — the client throws,
 * this step warns-and-skips, and every bucket row ends up with no physical
 * bucket behind it. Treat blank as unset.
 */
function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function makeS3Client(): S3Client {
  const endpointRaw = env('MINIO_ENDPOINT', 'localhost:9000');
  const useSsl = env('MINIO_USE_SSL', 'false').toLowerCase() === 'true';
  const endpoint = /^https?:\/\//.test(endpointRaw) ? endpointRaw : `${useSsl ? 'https' : 'http'}://${endpointRaw}`;
  return new S3Client({
    endpoint,
    region: env('MINIO_REGION', 'us-east-1'),
    credentials: {
      accessKeyId: env('MINIO_ACCESS_KEY', 'minio_admin'),
      secretAccessKey: env('MINIO_SECRET_KEY', 'minio_admin'),
    },
    forcePathStyle: true,
    maxAttempts: 2,
  });
}

/** What happened to each bucket name the step considered. */
export interface TenantBucketProvisionResult {
  created: string[];
  existing: string[];
  failed: Array<{ name: string; error: string }>;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const name = (error as { name?: string })?.name;
  return status === 404 || name === 'NotFound' || name === 'NoSuchBucket';
}

/**
 * `true` when this call created the bucket. Only a 404 from HeadBucket means
 * "missing"; any other HeadBucket error (unreachable store, denied credential)
 * is raised, so an outage is reported as a failure instead of triggering a
 * CreateBucket that would fail anyway with a less useful message.
 */
async function ensureBucket(s3: S3Client, bucket: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return false;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    return true;
  }
}

export const provisionTenantBuckets = async (client: CorePrismaClient): Promise<TenantBucketProvisionResult> => {
  console.log('Provisioning physical MinIO buckets for tenant buckets...');

  const buckets = await client.tenantBucket.findMany({
    where: { resourceStatus: { not: 'DELETED' } },
    select: { name: true },
    distinct: ['name'],
  });

  const result: TenantBucketProvisionResult = { created: [], existing: [], failed: [] };
  let s3: S3Client;
  try {
    s3 = makeS3Client();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.failed = buckets.map(({ name }) => ({ name, error: message }));
    reportFailures(result, buckets.length);
    return result;
  }

  for (const { name } of buckets) {
    try {
      if (await ensureBucket(s3, name)) result.created.push(name);
      else result.existing.push(name);
    } catch (error) {
      result.failed.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(
    `Provisioned ${result.created.length} new bucket(s), ${result.existing.length} already existed, ${result.failed.length} failed (${buckets.length} total)`,
  );
  reportFailures(result, buckets.length);
  return result;
};

function reportFailures(result: TenantBucketProvisionResult, total: number): void {
  if (result.failed.length === 0) return;
  console.error(
    `❌ ${result.failed.length} of ${total} tenant bucket(s) have NO physical bucket behind their row. ` +
      'Storage reads for them will fail with NoSuchBucket until repaired (POST admin/tenant-buckets/provision/:tenantId). ' +
      'Check MINIO_ENDPOINT / MINIO_USE_SSL / MINIO_ACCESS_KEY / MINIO_SECRET_KEY:',
  );
  for (const { name, error } of result.failed) {
    console.error(`   - ${name}: ${error}`);
  }
}
