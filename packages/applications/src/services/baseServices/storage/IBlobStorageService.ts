import { Readable } from 'stream';

import {
  BlobObjectHead,
  DeleteObjectParams,
  GetObjectParams,
  LifecycleRule,
  ListObjectsParams,
  ListObjectsResult,
  PresignGetParams,
  PresignPutParams,
  PresignedPutIntent,
  PresignPutIntentParams,
  PutObjectParams,
  StorageDescriptor,
} from './providers/IBlobStorageProvider';

/**
 * Provider-agnostic blob-storage entry point.
 *
 * Thin facade over the factory-selected {@link IBlobStorageProvider}. Consumers
 * depend on this token rather than a concrete provider so the backend can switch
 * between S3/MinIO and Azure via the `STORAGE_PROVIDER` config alone. Mirrors the
 * provider's data-plane operations; the active backend is chosen at runtime.
 */
export interface IBlobStorageService {
  putObject(params: PutObjectParams): Promise<void>;
  getObject(params: GetObjectParams): Promise<Buffer>;
  getObjectStream(params: GetObjectParams): Promise<Readable>;
  deleteObject(params: DeleteObjectParams): Promise<void>;
  listObjects(params: ListObjectsParams): Promise<ListObjectsResult>;
  presignGet(params: PresignGetParams): Promise<string>;
  presignPut(params: PresignPutParams): Promise<string>;
  /** Presigned PUT with content type / length (and S3 checksum) signed. Refused up front when the declared size would exceed the tenant's storage quota. */
  presignPutIntent(params: PresignPutIntentParams): Promise<PresignedPutIntent>;
  headObject(bucket: string, key: string): Promise<BlobObjectHead | null>;
  /** Inclusive byte range. */
  getObjectRange(bucket: string, key: string, start: number, end: number): Promise<Buffer>;
  /** Throws `QuotaExceededException` when storing `bytes` more would exceed the tenant's quota (fails open when usage is unreadable). */
  assertCanStore(bucket: string, bytes: number): Promise<void>;
  /** Adds bytes written straight to the store by a client (presigned PUT) to the cached tenant usage. */
  recordExternalWrite(bucket: string, bytes: number): Promise<void>;
  createBucket(bucket: string): Promise<void>;
  deleteBucket(bucket: string): Promise<void>;
  bucketExists(bucket: string): Promise<boolean>;
  setLifecycle(bucket: string, rules: LifecycleRule[]): Promise<void>;
  healthCheck(): Promise<boolean>;
  /**
   * Resolve a serializable storage descriptor for the current tenant's bucket,
   * for propagation to out-of-process workers (Python STT). Returns `null` for
   * SHARED/global tenants (worker uses its env-default client + bucket name).
   */
  resolveDescriptor(bucket: string): Promise<StorageDescriptor | null>;
}

/** DI token for {@link IBlobStorageService}. */
export const IBlobStorageService = Symbol('IBlobStorageService');
