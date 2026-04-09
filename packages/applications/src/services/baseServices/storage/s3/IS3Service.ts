import { PresignedUrlCommand } from './s3.service';

/**
 * Interface for S3-compatible storage service operations.
 * Provides file storage, retrieval, and management capabilities.
 */
export interface IS3Service {
  /**
   * Upload a file to S3 storage
   * @param bucketName - Name of the S3 bucket
   * @param fileKey - Key/path for the file in the bucket
   * @param fileData - File data as Buffer
   * @param mimetype - Optional MIME type for the file
   */
  putFile(bucketName: string, fileKey: string, fileData: Buffer, mimetype?: string): Promise<void>;

  /**
   * Download a file from S3 storage
   * @param bucketName - Name of the S3 bucket
   * @param fileKey - Key/path for the file in the bucket
   * @returns File data as Buffer
   */
  getFile(bucketName: string, fileKey: string): Promise<Buffer>;

  /**
   * List files in S3 storage with optional path prefix
   * @param bucketName - Name of the S3 bucket
   * @param path - Path prefix to filter files
   * @returns Array of file objects with metadata
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listFiles(bucketName: string, path: string): Promise<any[]>;

  /**
   * Copy a file within S3 storage
   * @param bucketName - Destination bucket name
   * @param fileKey - Destination file key
   * @param copySource - Source file path (bucket/key format)
   */
  copyFile(bucketName: string, fileKey: string, copySource: string): Promise<void>;

  /**
   * Delete a file from S3 storage
   * @param bucketName - Name of the S3 bucket
   * @param fileKey - Key/path for the file in the bucket
   */
  deleteFile(bucketName: string, fileKey: string): Promise<void>;

  /**
   * Generate a presigned URL for file access
   * @param bucketName - Name of the S3 bucket
   * @param fileKey - Key/path for the file in the bucket
   * @param command - Type of operation ('get' or 'list')
   * @returns Presigned URL string
   */
  signUrl(bucketName: string, fileKey: string, command: PresignedUrlCommand): Promise<string>;

  /**
   * Get the default public bucket name from configuration
   * @returns Public bucket name
   */
  getPublicBucketName(): string;

  /**
   * Get the default private bucket name from configuration
   * @returns Private bucket name
   */
  getPrivateBucketName(): string;

  /**
   * List all S3 buckets
   * @returns Array of bucket info objects
   */
  listAllBuckets(): Promise<{ name: string; creationDate?: string }[]>;

  /**
   * Create a new S3 bucket
   * @param bucketName - Name for the new bucket
   */
  createBucket(bucketName: string): Promise<void>;

  /**
   * Delete an S3 bucket
   * @param bucketName - Name of the bucket to delete
   */
  deleteBucket(bucketName: string): Promise<void>;

  /**
   * Update bucket metadata (description, resourceStatus) via bucket tags
   * @param bucketName - Name of the bucket to update
   * @param metadata - Optional description and resourceStatus to store
   * @returns Updated bucket info with name and metadata
   */
  updateBucket(
    bucketName: string,
    metadata?: { description?: string; resourceStatus?: string },
  ): Promise<{ name: string; description?: string; resourceStatus?: string }>;

  /**
   * Check if S3 service is properly configured
   * @returns true if all required configuration is available
   */
  isConfigured(): Promise<boolean>;

  /**
   * Test S3 connectivity
   * @returns true if connection is successful
   */
  testConnection(): Promise<boolean>;

  /**
   * Refresh S3 configuration from AppSettingsService
   * Useful when configuration changes at runtime
   */
  refreshConfiguration(): Promise<void>;

  /**
   * Check if the service is configured for MinIO
   * @returns true if MinIO endpoint is detected
   */
  isMinIOConfigured(): boolean;

  /**
   * Get MinIO-specific configuration details
   * @returns MinIO configuration information
   */
  getMinIOInfo(): { isMinIO: boolean; endpoint?: string; version?: string };

  /**
   * Set a bucket policy (IAM-style JSON policy document)
   * @param bucketName - Name of the S3 bucket
   * @param policy - Policy document as a JSON-serializable object
   */
  setBucketPolicy(bucketName: string, policy: Record<string, unknown>): Promise<void>;
}

export const IS3Service = Symbol('IS3Service');
