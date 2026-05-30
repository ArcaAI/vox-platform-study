/**
 * Cloud blob-storage provider types (TASK-318 / W1).
 *
 * Shared across packages so the backend storage abstraction, the SDK and the
 * admin UI agree on a single set of provider/topology identifiers. The string
 * values double as the accepted `STORAGE_PROVIDER` config values consumed by
 * the blob-storage provider factory.
 */

/**
 * Supported blob-storage backends.
 *
 * - `MINIO`     — S3-compatible MinIO (default; uses the AWS S3 SDK with
 *                 `forcePathStyle`).
 * - `AWS_S3`    — Amazon S3 (uses the AWS S3 SDK).
 * - `AZURE_BLOB`— Azure Storage Blob (uses the `@azure/storage-blob` SDK).
 */
export enum StorageProvider {
  MINIO = 'minio',
  AWS_S3 = 'aws_s3',
  AZURE_BLOB = 'azure_blob',
}

/**
 * How buckets/containers are laid out per tenant.
 *
 * - `SHARED`    — one bucket/container shared by all tenants (key-prefixed).
 * - `DEDICATED` — one bucket/container per tenant.
 */
export enum StorageTopology {
  SHARED = 'shared',
  DEDICATED = 'dedicated',
}
