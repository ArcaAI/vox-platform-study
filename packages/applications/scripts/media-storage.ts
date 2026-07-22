/**
 * Shared MinIO/S3 helpers for the media seed + thumbnail backfill scripts.
 *
 * These dev-tooling scripts talk to the SAME physical MinIO the API's
 * `IBlobStorageService` presigns against, using the AWS S3 SDK configured from
 * the `MINIO_*` vars in `.env.dev` (loaded as a side effect of importing
 * `@arcaai/database`). They intentionally bypass the NestJS DI graph
 * (AppSettings / Vault / SecretsService) while writing objects at the exact
 * `s3://<bucket>/<key>` convention `StorageController` uses — so
 * `ContextService.resolveMediaUrls` resolves them unchanged.
 *
 * Lives under `packages/applications/scripts/` (ESLint-ignored, build-excluded)
 * so it can import the package's own `ImageThumbnailService` source and the
 * `@aws-sdk/client-s3` / `sharp` deps that resolve here.
 */
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Build an S3 client pointed at the dev MinIO. Reads `MINIO_ENDPOINT`,
 * `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_USE_SSL` (all present in
 * `.env.dev`); `forcePathStyle` is required for MinIO bucket addressing.
 *
 * `maxAttempts` is forwarded to the SDK retry policy. The media seed passes `1`
 * so its storage-reachability probe fails FAST (no exponential-backoff retries)
 * when MinIO is absent — e.g. in CI, where the seed degrades to DB-rows-only.
 */
export function makeS3Client(options?: { maxAttempts?: number }): S3Client {
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
    ...(options?.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
  });
}

/** Whether a physical bucket exists (HeadBucket → 2xx). */
async function bucketExists(s3: S3Client, bucket: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the physical bucket exists, creating it if absent. Returns `true` when
 * a bucket was created, `false` when it already existed. Idempotent.
 */
export async function ensureBucket(s3: S3Client, bucket: string): Promise<boolean> {
  if (await bucketExists(s3, bucket)) {
    return false;
  }
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  return true;
}

/** Whether an object exists at `bucket/key` (HeadObject → 2xx). */
export async function objectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Upload (overwrite) an object. PUT-by-key is idempotent. */
export async function putObject(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

/** Download an object's bytes into a Buffer. */
export async function getObjectBytes(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (body?.transformToByteArray) {
    return Buffer.from(await body.transformToByteArray());
  }
  // Fallback for environments where the SDK stream mixin is unavailable.
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Parse a `Media.uri` of the canonical `s3://<bucket>/<key>` form into
 * `{ bucket, key }`. Mirrors `ContextService.parseStorageUri`; returns `null`
 * for any other shape so callers can skip (best-effort).
 */
export function parseStorageUri(uri: string | null | undefined): { bucket: string; key: string } | null {
  if (!uri) {
    return null;
  }
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    return null;
  }
  return { bucket: match[1], key: match[2] };
}
