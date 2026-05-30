import { Readable } from 'stream';

import {
  DeleteObjectParams,
  GetObjectParams,
  LifecycleRule,
  ListObjectsParams,
  ListObjectsResult,
  PresignGetParams,
  PresignPutParams,
  PutObjectParams,
} from './providers/IBlobStorageProvider';

/**
 * Provider-agnostic blob-storage entry point (TASK-318 / W1).
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
  createBucket(bucket: string): Promise<void>;
  deleteBucket(bucket: string): Promise<void>;
  bucketExists(bucket: string): Promise<boolean>;
  setLifecycle(bucket: string, rules: LifecycleRule[]): Promise<void>;
  healthCheck(): Promise<boolean>;
}

/** DI token for {@link IBlobStorageService}. */
export const IBlobStorageService = Symbol('IBlobStorageService');
