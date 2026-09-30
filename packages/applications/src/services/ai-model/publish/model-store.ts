/**
 * `ModelStore` — the model publisher's own view of the `hope-models` bucket
 * (TASK-1019 lane P, D-2 / D-3 / OD-2).
 *
 * WHY NOT `IS3Service`. `IS3Service` authenticates as the platform storage
 * principal (`hope-platform-rw`), which has NO rights on `hope-models` and must
 * not gain them — every gateway pod holds that key. The publisher writes AND
 * deletes model weights, so it authenticates with its own key pair, read from
 * two ENV secrets (`MODEL_STORE_PUBLISHER_ACCESS_KEY_ID` / `_SECRET_KEY`) that
 * the cluster delivers by `secretKeyRef` to the publisher pod alone. Not
 * `vault-kv`: a kv path is readable by hope-api's shared AppRole, and under
 * `SECRETS_PROVIDER=vault` `SecretsService` has no env fallback (TASK-1019 C3).
 * An absent key pair fails the job closed (`MODEL_STORE_CREDENTIAL_MISSING`);
 * it is never substituted by the platform storage credential.
 *
 * WHAT IT ADDS OVER `IS3Service`. Multipart upload FROM A LOCAL FILE (weights
 * are staged to disk, never held as one Buffer), a paginated prefix listing,
 * and a prefix delete that either leaves delete markers (the bucket is
 * versioned; ILM reclaims non-current versions after 30 days — a 30-day undo)
 * or purges every version now.
 *
 * Endpoint and region still come from the platform storage cascade
 * (`resolvePlatformStorageConfig`: SYSTEM row → AppSettings → bootstrap env):
 * the publisher talks to the SAME object store as everything else, as a
 * different principal.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Agent as HttpsAgent } from 'node:https';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { SYSTEM_TENANT_ID, TenantStorageConfigRepository } from '@arcaai/domains';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { minioCertCheckFromEnv, resolvePlatformStorageConfig } from '../../tenant-storage-config/platform-storage-config';
import { HOPE_MODELS_BUCKET } from '../constants';
import { MODEL_STORE_CREDENTIAL_MISSING, MODEL_STORE_PREFIX_REFUSED, ModelPublisherError } from './model-publisher.errors';
import { readModelPublisherTimeouts } from './model-publisher-timeouts.settings';

export { MODEL_STORE_CREDENTIAL_MISSING, ModelPublisherError } from './model-publisher.errors';

export interface ModelStore {
  headObject(key: string): Promise<{ size: number } | null>;
  /**
   * Upload a staged file; multipart at or above the part size. `signal`
   * (TASK-1023 D-C) aborts it: checked before every part, carried on every
   * request, and an open multipart upload is aborted on the way out.
   */
  uploadFile(key: string, localPath: string, opts?: { contentType?: string; signal?: AbortSignal }): Promise<void>;
  putSmall(key: string, body: Buffer | string): Promise<void>;
  /** Every CURRENT object under `prefix`, across all ListObjectsV2 pages. */
  listPrefix(prefix: string): AsyncIterable<{ key: string; size: number }>;
  /**
   * Delete everything under `prefix`. `purge: false` deletes current keys only
   * (the versioned bucket keeps delete markers until ILM expires them);
   * `purge: true` deletes every version and every delete marker now.
   */
  deletePrefix(prefix: string, opts: { purge: boolean }): Promise<{ objects: number; versions: number }>;
  /**
   * TASK-1023 OD-6 — delete exactly these CURRENT keys (the partial objects a
   * cancelled download wrote); returns how many were asked for.
   */
  deleteKeys(keys: string[]): Promise<number>;
}

/** The slice of `S3Client` the store uses — a fake in tests. */
export interface S3ClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's `send` is overloaded per command; the store narrows each response itself
  send(command: any, options?: { abortSignal?: AbortSignal }): Promise<any>;
}

/**
 * S3 protocol limits, not configuration: a part is at least 5 MiB (except the
 * last) and an upload has at most 10 000 parts. 64 MiB keeps the part count of
 * a 600 GiB object under the limit; larger objects grow the part size.
 */
const DEFAULT_PART_SIZE_BYTES = 64 * 1024 * 1024;
const MAX_PARTS = 10_000;
/** DeleteObjects accepts at most 1000 keys per request. */
const DELETE_BATCH = 1000;

/** Prefixes that are the ROOT of a layout — deleting one would take every model with it. */
const PROTECTED_PREFIXES: ReadonlySet<string> = new Set(['/', 'hf/', 'hf/hub/']);

export class S3ModelStore implements ModelStore {
  private readonly partSizeBytes: number;

  constructor(
    private readonly client: S3ClientLike,
    private readonly bucket: string,
    opts: { partSizeBytes?: number } = {},
  ) {
    this.partSizeBytes = opts.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
  }

  async headObject(key: string): Promise<{ size: number } | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(response?.ContentLength ?? 0) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async uploadFile(key: string, localPath: string, opts: { contentType?: string; signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = opts;
    signal?.throwIfAborted();
    const sendOpts = signal ? { abortSignal: signal } : undefined;
    const { size } = await stat(localPath);
    const partSize = Math.max(this.partSizeBytes, Math.ceil(size / MAX_PARTS));

    if (size < partSize) {
      const body = createReadStream(localPath);
      try {
        await this.client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentLength: size, ContentType: opts.contentType }),
          sendOpts,
        );
      } finally {
        body.destroy();
      }
      return;
    }

    const created = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: opts.contentType }),
      sendOpts,
    );
    const uploadId = String(created?.UploadId ?? '');
    if (!uploadId) throw new Error(`CreateMultipartUpload returned no UploadId for '${key}'`);

    try {
      const parts: Array<{ PartNumber: number; ETag: string }> = [];
      for (let offset = 0, partNumber = 1; offset < size; offset += partSize, partNumber++) {
        signal?.throwIfAborted();
        const length = Math.min(partSize, size - offset);
        const body = createReadStream(localPath, { start: offset, end: offset + length - 1 });
        try {
          const uploaded = await this.client.send(
            new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: length }),
            sendOpts,
          );
          parts.push({ PartNumber: partNumber, ETag: String(uploaded?.ETag ?? '') });
        } finally {
          body.destroy();
        }
      }
      signal?.throwIfAborted();
      await this.client.send(
        new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }),
        sendOpts,
      );
    } catch (error) {
      // An abandoned multipart upload holds its parts' bytes (and the bucket
      // quota) until aborted; the original error is the one worth reporting.
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
      throw error;
    }
  }

  async putSmall(key: string, body: Buffer | string): Promise<void> {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentLength: bytes.length }));
  }

  async *listPrefix(prefix: string): AsyncIterable<{ key: string; size: number }> {
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }),
      );
      for (const item of (response?.Contents ?? []) as Array<{ Key?: string; Size?: number }>) {
        if (item.Key) yield { key: item.Key, size: Number(item.Size ?? 0) };
      }
      continuationToken = response?.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async deletePrefix(prefix: string, opts: { purge: boolean }): Promise<{ objects: number; versions: number }> {
    assertDeletablePrefix(prefix);
    return opts.purge ? this.purgePrefix(prefix) : this.deleteCurrent(prefix);
  }

  private async deleteCurrent(prefix: string): Promise<{ objects: number; versions: number }> {
    let objects = 0;
    let batch: Array<{ Key: string }> = [];
    for await (const item of this.listPrefix(prefix)) {
      batch.push({ Key: item.key });
      if (batch.length === DELETE_BATCH) {
        await this.deleteBatch(batch);
        objects += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.deleteBatch(batch);
      objects += batch.length;
    }
    return { objects, versions: 0 };
  }

  private async purgePrefix(prefix: string): Promise<{ objects: number; versions: number }> {
    let objects = 0;
    let versions = 0;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let batch: Array<{ Key: string; VersionId: string }> = [];

    const flush = async () => {
      if (batch.length === 0) return;
      await this.deleteBatch(batch);
      versions += batch.length;
      batch = [];
    };

    do {
      const response = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
        }),
      );
      const entries = [...((response?.Versions ?? []) as VersionEntry[]), ...((response?.DeleteMarkers ?? []) as VersionEntry[])];
      for (const version of (response?.Versions ?? []) as VersionEntry[]) {
        if (version.IsLatest) objects++;
      }
      for (const entry of entries) {
        if (!entry.Key || !entry.VersionId) continue;
        batch.push({ Key: entry.Key, VersionId: entry.VersionId });
        if (batch.length === DELETE_BATCH) await flush();
      }
      const truncated = Boolean(response?.IsTruncated);
      keyMarker = truncated ? response.NextKeyMarker : undefined;
      versionIdMarker = truncated ? response.NextVersionIdMarker : undefined;
      if (!truncated) break;
    } while (keyMarker || versionIdMarker);

    await flush();
    return { objects, versions };
  }

  async deleteKeys(keys: string[]): Promise<number> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      await this.deleteBatch(keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key })));
    }
    return keys.length;
  }

  private async deleteBatch(objects: Array<{ Key: string; VersionId?: string }>): Promise<void> {
    const response = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } }));
    const errors = (response?.Errors ?? []) as Array<{ Key?: string; Code?: string; Message?: string }>;
    if (errors.length > 0) {
      const first = errors[0];
      throw new Error(`DeleteObjects failed for ${errors.length} key(s); first: '${first.Key}' ${first.Code ?? ''} ${first.Message ?? ''}`.trim());
    }
  }
}

interface VersionEntry {
  Key?: string;
  VersionId?: string;
  IsLatest?: boolean;
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * A prefix is deletable only when it names a DIRECTORY below a layout root:
 * non-empty, relative, ending in `/`, and not one of the roots every model
 * lives under. The check is here, at the one place that deletes, rather than
 * trusted to each caller's derivation.
 */
export function assertDeletablePrefix(prefix: string): void {
  if (!prefix || !prefix.endsWith('/') || prefix.startsWith('/') || PROTECTED_PREFIXES.has(prefix)) {
    throw new ModelPublisherError(
      MODEL_STORE_PREFIX_REFUSED,
      `refusing to delete bucket prefix '${prefix}' (must be a non-root directory prefix ending in '/')`,
    );
  }
}

/** Builds the S3 client — injectable so a test can prove it is never called. */
export type ModelStoreClientFactory = (config: S3ClientConfig) => S3ClientLike;
export const MODEL_STORE_CLIENT_FACTORY = Symbol('MODEL_STORE_CLIENT_FACTORY');

/** The environment the key pair is read from — `process.env` unless a test injects one. */
export type ModelStoreEnv = Readonly<Record<string, string | undefined>>;
export const MODEL_STORE_ENV = Symbol('MODEL_STORE_ENV');

const defaultClientFactory: ModelStoreClientFactory = (config) => new S3Client(config);

/**
 * Builds a `ModelStore` per job. Credentials are read fresh on every call (a
 * rotated key pair takes effect on the next job without a restart) and are
 * checked FIRST, so a missing credential fails before any storage lookup.
 */
@Injectable()
export class ModelStoreFactory {
  private readonly createClient: ModelStoreClientFactory;
  private readonly env: ModelStoreEnv;

  constructor(
    @Optional() private readonly storageConfigRepository?: TenantStorageConfigRepository,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: IAppSettingsService,
    @Optional() @Inject(MODEL_STORE_ENV) env?: ModelStoreEnv,
    @Optional() @Inject(MODEL_STORE_CLIENT_FACTORY) createClient?: ModelStoreClientFactory,
  ) {
    this.env = env ?? process.env;
    this.createClient = createClient ?? defaultClientFactory;
  }

  async create(): Promise<ModelStore> {
    // Env-tier secrets (`bootstrap-env.descriptors.ts`), set on the publisher pod alone.
    const accessKeyId = this.env['MODEL_STORE_PUBLISHER_ACCESS_KEY_ID']?.trim();
    const secretAccessKey = this.env['MODEL_STORE_PUBLISHER_SECRET_KEY']?.trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new ModelPublisherError(
        MODEL_STORE_CREDENTIAL_MISSING,
        'the model publisher key pair (env MODEL_STORE_PUBLISHER_ACCESS_KEY_ID / MODEL_STORE_PUBLISHER_SECRET_KEY on the publisher pod) is not set; the publisher never falls back to the platform storage credential',
      );
    }

    const rows = this.storageConfigRepository ? await this.storageConfigRepository.findAllTenantDefaults(SYSTEM_TENANT_ID) : [];
    const config = resolvePlatformStorageConfig({
      systemRow: rows[0] ?? null,
      appSettings: {
        STORAGE_PROVIDER: this.appSettings?.getValueWithDefault<string>('STORAGE_PROVIDER', '') ?? '',
        S3_ENDPOINT: this.appSettings?.getValueWithDefault<string>('S3_ENDPOINT', '') ?? '',
        S3_REGION: this.appSettings?.getValueWithDefault<string>('S3_REGION', '') ?? '',
        S3_FORCE_PATH_STYLE: this.appSettings?.getValueWithDefault<boolean>('S3_FORCE_PATH_STYLE', true) ?? true,
        AZURE_STORAGE_ACCOUNT: this.appSettings?.getValueWithDefault<string>('AZURE_STORAGE_ACCOUNT', '') ?? '',
        AZURE_STORAGE_ENDPOINT_SUFFIX: this.appSettings?.getValueWithDefault<string>('AZURE_STORAGE_ENDPOINT_SUFFIX', '') ?? '',
      },
      env: this.env,
    });

    const endpoint = config.endpoint.trim();
    const client = this.createClient({
      ...(endpoint ? { endpoint } : {}),
      region: config.region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: config.forcePathStyle,
      // Streamed bodies must not be wrapped in aws-chunked checksum trailers,
      // which S3-compatible stores (MinIO) do not all accept. Operations that
      // REQUIRE a checksum (DeleteObjects) still get one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // I7 — every request is bounded: a half-open socket on a part upload
      // must FAIL (and the job retry), never hold the concurrency-1 queue
      // forever. `throwOnRequestTimeout` turns the SDK's default warning into
      // an error. The TLS relaxation is the same deliberate, reversible one as
      // `S3Service` (owner ruling 2026-08-30, `MINIO_CERT_CHECK`) — grep it to
      // revert every site.
      requestHandler: new NodeHttpHandler({
        requestTimeout: readModelPublisherTimeouts(this.appSettings).requestTimeoutMs,
        throwOnRequestTimeout: true,
        ...(minioCertCheckFromEnv(this.env) ? {} : { httpsAgent: new HttpsAgent({ rejectUnauthorized: false }) }),
      }),
    });

    return new S3ModelStore(client, HOPE_MODELS_BUCKET);
  }
}
