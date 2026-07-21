import { Readable } from 'stream';

import { StorageProvider } from '@arcaai/types';

/**
 * Provider-agnostic blob-storage abstraction.
 *
 * A single interface implemented by every storage backend (AWS S3, MinIO,
 * Azure Blob). The "bucket" vocabulary is used throughout; the Azure provider
 * maps `bucket` → container. This wave is additive — nothing wires these
 * providers into existing consumers yet.
 */

/** Identifies a single object within a bucket/container. */
export interface BlobObjectLocation {
  /** Bucket (S3) / container (Azure) name. */
  bucket: string;
  /** Object key / blob name. */
  key: string;
}

export interface PutObjectParams extends BlobObjectLocation {
  /** Raw bytes to store. */
  body: Buffer | Uint8Array;
  /** Optional MIME type stored as Content-Type / blobContentType. */
  contentType?: string;
  /** Optional user metadata stored alongside the object. */
  metadata?: Record<string, string>;
}

export type GetObjectParams = BlobObjectLocation;

export type DeleteObjectParams = BlobObjectLocation;

export interface ListObjectsParams {
  bucket: string;
  /** Restrict results to keys beginning with this prefix. */
  prefix?: string;
  /** Opaque token returned by a previous call to fetch the next page. */
  continuationToken?: string;
  /** Maximum number of keys to return in this page. */
  maxKeys?: number;
}

/** Lightweight summary returned by {@link IBlobStorageProvider.listObjects}. */
export interface BlobObjectSummary {
  key: string;
  size: number;
  lastModified?: Date;
}

/**
 * Result of a paginated list. `nextContinuationToken` + `isTruncated` allow
 * the caller to walk every page — there is no hard 1000-object cap.
 */
export interface ListObjectsResult {
  objects: BlobObjectSummary[];
  nextContinuationToken?: string;
  isTruncated: boolean;
}

export interface PresignGetParams extends BlobObjectLocation {
  /** Lifetime of the signed URL in seconds. */
  expiresInSeconds: number;
}

export interface PresignPutParams extends BlobObjectLocation {
  /** Lifetime of the signed URL in seconds. */
  expiresInSeconds: number;
  /** Optional Content-Type the caller is expected to upload with. */
  contentType?: string;
}

/**
 * A single object-expiration lifecycle rule. Intentionally minimal — only the
 * subset of S3 lifecycle / Azure ILM that maps cleanly across providers.
 */
export interface LifecycleRule {
  /** Stable rule identifier. */
  id: string;
  /** Apply the rule only to keys under this prefix (default: whole bucket). */
  prefix?: string;
  /** Whether the rule is active. */
  enabled: boolean;
  /** Expire (delete) objects this many days after creation. */
  expirationDays?: number;
}

/**
 * Serializable storage descriptor handed to out-of-process workers (e.g. the
 * Python STT service) so they can connect to a DEDICATED tenant's S3/Azure
 * backend directly. Keys are snake_case to match the worker-side contract.
 *
 * Only ever built for DEDICATED tenants — SHARED tenants resolve to `null`, so
 * credentials are never distributed for the common shared-platform case (the
 * worker uses its own env-configured default client + the bucket name).
 */
export interface StorageDescriptor {
  provider: 'minio' | 'aws_s3' | 'azure_blob';
  bucket: string;
  // S3 / MinIO
  endpoint?: string;
  region?: string;
  force_path_style?: boolean;
  access_key_id?: string;
  secret_access_key?: string;
  // Azure Blob
  account_name?: string;
  endpoint_suffix?: string;
  connection_string?: string;
  account_key?: string;
}

/**
 * Thrown when an operation is not available on the active provider's data-plane
 * SDK (e.g. Azure blob lifecycle management, which is an account-level
 * management-plane operation). Provider-agnostic on purpose — it is not an
 * HTTP exception so it can surface identically regardless of backend.
 */
export class StorageNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageNotSupportedError';
  }
}

/**
 * The contract every storage backend implements. All methods are async and
 * throw the underlying SDK error on failure (callers decide how to map them).
 */
export interface IBlobStorageProvider {
  /** Which backend this instance talks to. */
  readonly provider: StorageProvider;

  /** Upload an object, optionally with a content type and user metadata. */
  putObject(params: PutObjectParams): Promise<void>;

  /** Download an object's full contents as a Buffer. */
  getObject(params: GetObjectParams): Promise<Buffer>;

  /** Open a readable stream over an object's contents. */
  getObjectStream(params: GetObjectParams): Promise<Readable>;

  /** Delete an object. Succeeds even if the object does not exist. */
  deleteObject(params: DeleteObjectParams): Promise<void>;

  /** List objects in a bucket with real, token-based pagination. */
  listObjects(params: ListObjectsParams): Promise<ListObjectsResult>;

  /** Generate a time-limited URL granting read access to an object. */
  presignGet(params: PresignGetParams): Promise<string>;

  /** Generate a time-limited URL granting upload (write) access to an object. */
  presignPut(params: PresignPutParams): Promise<string>;

  /** Create a bucket/container (idempotent — no error if it already exists). */
  createBucket(bucket: string): Promise<void>;

  /**
   * Delete a bucket/container. NEVER invoked at runtime in W1 — destructive.
   * Implemented for completeness/admin tooling only.
   */
  deleteBucket(bucket: string): Promise<void>;

  /** Whether a bucket/container exists. */
  bucketExists(bucket: string): Promise<boolean>;

  /**
   * Configure object-expiration lifecycle rules. Implemented for S3/MinIO.
   * The Azure provider throws {@link StorageNotSupportedError} because blob
   * lifecycle (ILM) is a management-plane operation absent from the
   * `@azure/storage-blob` data SDK.
   */
  setLifecycle(bucket: string, rules: LifecycleRule[]): Promise<void>;

  /** Cheap connectivity/credentials probe. Returns false on any failure. */
  healthCheck(): Promise<boolean>;
}

/** DI token for {@link IBlobStorageProvider}. */
export const IBlobStorageProvider = Symbol('IBlobStorageProvider');
