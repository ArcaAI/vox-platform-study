import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  ListBucketsCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutBucketTaggingCommand,
  GetBucketTaggingCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { IAppSettingsService } from '../../_meta/';
import { IS3Service } from './IS3Service';
import { NotFoundException } from '@arcaai/exceptions';

const DEFAULT_PRESIGNED_URL_EXPIRY = 3600;

export type PresignedUrlCommand = 'get' | 'list';

/**
 * S3Service provides file storage operations using S3-compatible storage.
 *
 * Configuration is loaded from AppSettingsService with the following keys:
 * - S3_ENDPOINT: S3 service endpoint URL
 * - S3_REGION: S3 region (default: 'us-east-1')
 * - S3_ACCESS_KEY: S3 access key
 * - S3_SECRET_KEY: S3 secret key
 * - S3_PUBLIC_BUCKET: Default public bucket name
 * - S3_PRIVATE_BUCKET: Default private bucket name
 * - S3_FORCE_PATH_STYLE: Force path-style URLs (default: true for MinIO compatibility)
 * - S3_REJECT_UNAUTHORIZED: Reject unauthorized SSL certificates (default: false)
 * - S3_PRESIGNED_URL_EXPIRY: Presigned URL expiry in seconds (default: 3600)
 */
@Injectable()
export class S3Service implements IS3Service, OnModuleInit {
  private readonly logger: Logger = new Logger(S3Service.name);
  private s3Client: S3Client | null = null;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private configurationAvailable = false;

  constructor(@Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService) {
    this.logger.log({
      message: 'Service created',
      service: S3Service.name,
    });
  }

  /**
   * Initialize the S3 service after the module is loaded
   * Only initializes if S3 configuration is available in AppSettings
   */
  async onModuleInit(): Promise<void> {
    try {
      // Wait for AppSettings to be fully initialized
      await this.waitForAppSettingsInitialization();

      // Check if S3 configuration is available
      if (await this.hasRequiredConfiguration()) {
        this.logger.log({
          message: 'S3 configuration detected, initializing client',
        });
        await this.initializeS3Client();
      } else {
        this.logger.warn({
          message: 'S3 configuration not found in AppSettings',
          status: 'uninitialized',
          action: 'will_initialize_on_first_use',
        });
        this.configurationAvailable = false;
      }
    } catch (error) {
      this.logger.error({
        message: 'Failed to initialize S3 service during module init',
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw here to prevent module initialization failure
      // S3 service will attempt lazy initialization on first use
    }
  }

  /**
   * Wait for AppSettings service to be fully initialized
   */
  private async waitForAppSettingsInitialization(): Promise<void> {
    const maxWaitTime = 30000; // 30 seconds
    const checkInterval = 100; // 100ms
    let elapsed = 0;

    while (elapsed < maxWaitTime) {
      const stats = this.appSettingsService.getCacheStats();
      if (stats.isInitialized) {
        this.logger.debug({
          message: 'AppSettings service is initialized',
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, checkInterval));
      elapsed += checkInterval;
    }

    throw new Error('AppSettings service failed to initialize within timeout period');
  }

  /**
   * Check if required S3 configuration is available
   */
  private async hasRequiredConfiguration(): Promise<boolean> {
    try {
      const requiredKeys = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];

      for (const key of requiredKeys) {
        if (!this.appSettingsService.hasSetting(key)) {
          this.logger.debug({
            message: 'Required S3 setting missing',
            settingKey: key,
          });
          return false;
        }

        const value = this.appSettingsService.getValueFromCache(key);
        if (!value || (typeof value === 'string' && value.trim() === '')) {
          this.logger.debug({
            message: 'Required S3 setting is empty',
            settingKey: key,
          });
          return false;
        }
      }

      this.configurationAvailable = true;
      return true;
    } catch (error) {
      this.logger.error({
        message: 'Error checking S3 configuration',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Initialize the S3 client with configuration from AppSettingsService
   */
  private async initializeS3Client(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._initializeS3Client();
    return this.initializationPromise;
  }

  private async _initializeS3Client(): Promise<void> {
    try {
      this.logger.log({
        message: 'Initializing S3 client',
        source: 'AppSettingsService',
      });

      // Ensure AppSettings is ready and configuration is available
      if (!this.configurationAvailable && !(await this.hasRequiredConfiguration())) {
        throw new Error('S3 configuration is not available in AppSettings');
      }

      // Get S3 configuration from app settings
      const s3Config = this.getS3Configuration();

      // Validate required configuration
      this.validateS3Configuration(s3Config);

      // Create S3 client with MinIO optimizations
      this.s3Client = new S3Client({
        endpoint: s3Config.endpoint,
        region: s3Config.region,
        credentials: {
          accessKeyId: s3Config.accessKey,
          secretAccessKey: s3Config.secretKey,
        },
        forcePathStyle: s3Config.forcePathStyle,
        maxAttempts: s3Config.maxRetries,
        // MinIO-specific client configuration
        ...(s3Config.isMinIO && {
          // Disable AWS-specific features for MinIO
          disableHostPrefix: true,
        }),
      });

      this.isInitialized = true;
      this.configurationAvailable = true;
      this.logger.log('S3 client initialized successfully', {
        endpoint: s3Config.endpoint,
        region: s3Config.region,
        forcePathStyle: s3Config.forcePathStyle,
        isMinIO: s3Config.isMinIO,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to initialize S3 client',
        error: error instanceof Error ? error.message : String(error),
      });
      this.isInitialized = false;
      this.configurationAvailable = false;
      throw new Error(`S3 service initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get S3 configuration from AppSettingsService with defaults
   * Optimized for MinIO compatibility
   */
  private getS3Configuration() {
    // Ensure AppSettings cache is available
    if (!this.appSettingsService.getCacheStats().isInitialized) {
      throw new Error('AppSettings service is not initialized');
    }

    const endpoint = this.appSettingsService.getValueWithDefault('S3_ENDPOINT', '');
    const isMinIO = this.isMinIOEndpoint(endpoint);

    return {
      endpoint,
      region: this.appSettingsService.getValueWithDefault('S3_REGION', isMinIO ? 'us-east-1' : 'us-east-1'),
      accessKey: this.appSettingsService.getValueWithDefault('S3_ACCESS_KEY', ''),
      secretKey: this.appSettingsService.getValueWithDefault('S3_SECRET_KEY', ''),
      publicBucket: this.appSettingsService.getValueWithDefault('S3_PUBLIC_BUCKET', ''),
      privateBucket: this.appSettingsService.getValueWithDefault('S3_PRIVATE_BUCKET', ''),
      // MinIO requires forcePathStyle: true, AWS S3 can use either
      forcePathStyle: this.appSettingsService.getValueWithDefault('S3_FORCE_PATH_STYLE', isMinIO ? true : true),
      // MinIO often runs with self-signed certificates in development
      rejectUnauthorized: this.appSettingsService.getValueWithDefault('S3_REJECT_UNAUTHORIZED', isMinIO ? false : true),
      presignedUrlExpiry: this.appSettingsService.getValueWithDefault('S3_PRESIGNED_URL_EXPIRY', DEFAULT_PRESIGNED_URL_EXPIRY),
      // MinIO-specific settings
      isMinIO,
      maxRetries: this.appSettingsService.getValueWithDefault('S3_MAX_RETRIES', 3),
      requestTimeout: this.appSettingsService.getValueWithDefault('S3_REQUEST_TIMEOUT', 30000),
    };
  }

  /**
   * Detect if the endpoint is MinIO based on common patterns
   */
  private isMinIOEndpoint(endpoint: string): boolean {
    if (!endpoint) return false;

    const minioPatterns = [/localhost/i, /127\.0\.0\.1/, /minio/i, /:9000$/, /:9001$/];

    return minioPatterns.some((pattern) => pattern.test(endpoint));
  }

  /**
   * Validate S3 configuration with MinIO-specific checks
   */
  private validateS3Configuration(config: ReturnType<typeof this.getS3Configuration>): void {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!config.endpoint) {
      errors.push('S3_ENDPOINT is required');
    } else {
      // Validate endpoint format
      try {
        const url = new URL(config.endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push('S3_ENDPOINT must use http:// or https:// protocol');
        }
      } catch {
        errors.push('S3_ENDPOINT must be a valid URL');
      }
    }

    if (!config.accessKey) {
      errors.push('S3_ACCESS_KEY is required');
    }
    if (!config.secretKey) {
      errors.push('S3_SECRET_KEY is required');
    }

    // MinIO-specific validations and warnings
    if (config.isMinIO) {
      if (config.forcePathStyle !== true) {
        warnings.push('MinIO requires forcePathStyle: true for proper operation');
      }

      if (config.endpoint.startsWith('http://') && config.rejectUnauthorized === true) {
        warnings.push('HTTP endpoint detected with rejectUnauthorized: true - this may cause connection issues');
      }

      if (config.endpoint.includes('localhost') || config.endpoint.includes('127.0.0.1')) {
        warnings.push('Localhost endpoint detected - ensure MinIO is running locally');
      }
    }

    // Log warnings
    warnings.forEach((warning) => {
      this.logger.warn({
        message: 'S3 configuration warning',
        warning,
        isMinIO: config.isMinIO,
      });
    });

    if (errors.length > 0) {
      throw new Error(`S3 configuration validation failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Ensure S3 client is initialized before operations
   */
  private async ensureInitialized(): Promise<S3Client> {
    if (!this.isInitialized || !this.s3Client) {
      // Check if configuration is now available (might have been added after module init)
      if (!this.configurationAvailable && !(await this.hasRequiredConfiguration())) {
        throw new Error('S3 service is not configured. Please ensure S3 configuration is available in AppSettings.');
      }

      await this.initializeS3Client();
    }

    if (!this.s3Client) {
      throw new Error('S3 client is not initialized');
    }

    return this.s3Client;
  }

  /**
   * Get the default public bucket name
   */
  public getPublicBucketName(): string {
    if (!this.appSettingsService.getCacheStats().isInitialized) {
      this.logger.warn({
        message: 'AppSettings not initialized',
        action: 'returning_empty_bucket_name',
        bucketType: 'public',
      });
      return '';
    }
    return this.appSettingsService.getValueWithDefault('S3_PUBLIC_BUCKET', '');
  }

  /**
   * Get the default private bucket name
   */
  public getPrivateBucketName(): string {
    if (!this.appSettingsService.getCacheStats().isInitialized) {
      this.logger.warn({
        message: 'AppSettings not initialized',
        action: 'returning_empty_bucket_name',
        bucketType: 'private',
      });
      return '';
    }
    return this.appSettingsService.getValueWithDefault('S3_PRIVATE_BUCKET', '');
  }

  /**
   * Check if S3 service is properly configured and initialized
   */
  public async isConfigured(): Promise<boolean> {
    try {
      // First check if AppSettings is initialized
      if (!this.appSettingsService.getCacheStats().isInitialized) {
        return false;
      }

      // Then check if required configuration is available
      return await this.hasRequiredConfiguration();
    } catch {
      return false;
    }
  }

  public async putFile(bucketName: string, fileKey: string, fileData: Buffer, mimetype?: string): Promise<void> {
    const s3 = await this.ensureInitialized();

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: fileKey,
          Body: fileData,
          ContentType: mimetype,
        }),
      );

      this.logger.debug({
        message: 'File uploaded successfully',
        bucket: bucketName,
        fileKey,
        mimetype,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error uploading file to S3',
        bucket: bucketName,
        fileKey,
        error: error instanceof Error ? error.message : String(error),
      });
      this.debugLog(error);
      throw error;
    }
  }

  public async getFile(bucketName: string, fileKey: string): Promise<Buffer> {
    const s3 = await this.ensureInitialized();

    try {
      const data = await s3.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: fileKey,
        }),
      );

      if (!data.Body) {
        throw new NotFoundException(`File not found in S3: ${bucketName}/${fileKey}`);
      }

      const bodyContents = await this.streamToBuffer(data.Body as NodeJS.ReadableStream);

      this.logger.debug({
        message: 'File retrieved successfully',
        bucket: bucketName,
        fileKey,
        sizeBytes: bodyContents.length,
      });
      return bodyContents;
    } catch (error) {
      this.logger.error({
        message: 'Error fetching file from S3',
        bucket: bucketName,
        fileKey,
        error: error instanceof Error ? error.message : String(error),
      });
      this.debugLog(error);
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async listFiles(bucketName: string, path: string): Promise<any[]> {
    const s3 = await this.ensureInitialized();

    try {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: path,
        }),
      );

      if (response.Contents) {
        const files = response.Contents.map((item) => ({
          key: item.Key ?? 'No Key', // Safety check for undefined keys
          size: item.Size ?? 0, // Safety check for undefined sizes
          lastModified: item.LastModified,
          etag: item.ETag,
        }));

        this.logger.debug({
          message: 'Listed files from S3',
          bucket: bucketName,
          path,
          fileCount: files.length,
        });
        return files;
      } else {
        this.logger.debug({
          message: 'No files found in S3',
          bucket: bucketName,
          path,
        });
        return [];
      }
    } catch (error) {
      this.logger.error({
        message: 'Error listing files from S3',
        bucket: bucketName,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      this.debugLog(error);
      throw error;
    }
  }

  public async copyFile(bucketName: string, fileKey: string, copySource: string): Promise<void> {
    const s3 = await this.ensureInitialized();

    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: bucketName,
          Key: fileKey,
          CopySource: copySource,
        }),
      );

      this.logger.debug({
        message: 'File copied successfully',
        bucket: bucketName,
        fileKey,
        copySource,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error copying file in S3',
        bucket: bucketName,
        fileKey,
        copySource,
        error: error instanceof Error ? error.message : String(error),
      });
      this.debugLog(error);
      throw error;
    }
  }

  public async deleteFile(bucketName: string, fileKey: string): Promise<void> {
    const s3 = await this.ensureInitialized();

    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucketName,
          Key: fileKey,
        }),
      );

      this.logger.debug({
        message: 'File deleted successfully',
        bucket: bucketName,
        fileKey,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error deleting file from S3',
        bucket: bucketName,
        fileKey,
        error: error instanceof Error ? error.message : String(error),
      });
      this.debugLog(error);
      throw error;
    }
  }

  public async listAllBuckets(): Promise<{ name: string; creationDate?: string }[]> {
    const s3 = await this.ensureInitialized();

    try {
      const response = await s3.send(new ListBucketsCommand({}));
      const buckets = (response.Buckets ?? []).map((b) => ({
        name: b.Name ?? '',
        creationDate: b.CreationDate?.toISOString(),
      }));

      this.logger.debug({
        message: 'Listed all S3 buckets',
        bucketCount: buckets.length,
      });
      return buckets;
    } catch (error) {
      this.logger.error({
        message: 'Error listing S3 buckets',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async createBucket(bucketName: string): Promise<void> {
    if (!bucketName || /[.]{2}|[/\\]/.test(bucketName)) {
      throw new Error(`Invalid bucket name: ${bucketName}`);
    }
    const s3 = await this.ensureInitialized();

    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucketName }));

      this.logger.log({
        message: 'Bucket created successfully',
        bucket: bucketName,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error creating S3 bucket',
        bucket: bucketName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async deleteBucket(bucketName: string): Promise<void> {
    if (!bucketName) {
      throw new Error('Bucket name is required');
    }
    const s3 = await this.ensureInitialized();

    try {
      await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));

      this.logger.log({
        message: 'Bucket deleted successfully',
        bucket: bucketName,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error deleting S3 bucket',
        bucket: bucketName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async updateBucket(
    bucketName: string,
    metadata?: { description?: string; resourceStatus?: string },
  ): Promise<{ name: string; description?: string; resourceStatus?: string }> {
    if (!bucketName || /[.]{2}|[/\\]/.test(bucketName)) {
      throw new Error(`Invalid bucket name: ${bucketName}`);
    }
    const s3 = await this.ensureInitialized();

    const result: { name: string; description?: string; resourceStatus?: string } = { name: bucketName };

    if (metadata?.description !== undefined) {
      result.description = metadata.description;
    }
    if (metadata?.resourceStatus !== undefined) {
      result.resourceStatus = metadata.resourceStatus;
    }

    try {
      const tagMap = new Map<string, string>();

      try {
        const existing = await s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
        if (existing.TagSet) {
          for (const tag of existing.TagSet) {
            if (tag.Key && tag.Value) {
              tagMap.set(tag.Key, tag.Value);
            }
          }
        }
      } catch {
        // Bucket may have no tags - continue with empty map
      }

      if (metadata?.description !== undefined) {
        tagMap.set('description', metadata.description);
      }
      if (metadata?.resourceStatus !== undefined) {
        tagMap.set('resourceStatus', metadata.resourceStatus);
      }

      if (tagMap.size > 0) {
        await s3.send(
          new PutBucketTaggingCommand({
            Bucket: bucketName,
            Tagging: {
              TagSet: Array.from(tagMap.entries()).map(([Key, Value]) => ({ Key, Value })),
            },
          }),
        );
      }

      this.logger.debug({
        message: 'Bucket metadata updated',
        bucket: bucketName,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error updating S3 bucket metadata',
        bucket: bucketName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return result;
  }

  public async signUrl(bucketName: string, fileKey: string, command: PresignedUrlCommand = 'get'): Promise<string> {
    const s3 = await this.ensureInitialized();
    const config = this.getS3Configuration();

    try {
      let signedUrl: string;

      if (command === 'list') {
        signedUrl = await getSignedUrl(
          s3,
          new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: fileKey,
          }),
          { expiresIn: config.presignedUrlExpiry },
        );
      } else {
        signedUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: bucketName,
            Key: fileKey,
          }),
          { expiresIn: config.presignedUrlExpiry },
        );
      }

      this.logger.debug({
        message: 'Generated presigned URL',
        bucket: bucketName,
        fileKey,
        command,
        expiresInSeconds: config.presignedUrlExpiry,
      });
      return signedUrl;
    } catch (error) {
      this.logger.error({
        message: 'Error generating presigned URL',
        bucket: bucketName,
        fileKey,
        command,
        error: error instanceof Error ? error.message : String(error),
      });
      this.debugLog(error);
      throw error;
    }
  }

  /**
   * Test S3 connectivity by attempting to list buckets
   */
  public async testConnection(): Promise<boolean> {
    try {
      const s3 = await this.ensureInitialized();
      const config = this.getS3Configuration();

      // For MinIO, try a simple HEAD operation first
      if (config.isMinIO) {
        const bucketName = this.getPublicBucketName() || this.getPrivateBucketName();
        if (bucketName) {
          // Test with existing bucket
          await s3.send(
            new ListObjectsV2Command({
              Bucket: bucketName,
              MaxKeys: 1,
            }),
          );
        } else {
          // If no buckets configured, try to list with a common test bucket name
          await s3.send(
            new ListObjectsV2Command({
              Bucket: 'test-bucket',
              MaxKeys: 1,
            }),
          );
        }
      } else {
        // For AWS S3, use standard test
        await s3.send(
          new ListObjectsV2Command({
            Bucket: this.getPublicBucketName() || 'test-bucket',
            MaxKeys: 1,
          }),
        );
      }

      this.logger.debug({
        message: 'S3 connection test successful',
        provider: config.isMinIO ? 'MinIO' : 'AWS S3',
      });
      return true;
    } catch (error) {
      this.logger.warn({
        message: 'S3 connection test failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Check if the service is configured for MinIO
   */
  public isMinIOConfigured(): boolean {
    try {
      if (!this.appSettingsService.getCacheStats().isInitialized) {
        return false;
      }
      const config = this.getS3Configuration();
      return config.isMinIO;
    } catch {
      return false;
    }
  }

  /**
   * Get MinIO-specific configuration details
   */
  public getMinIOInfo(): { isMinIO: boolean; endpoint?: string; version?: string } {
    try {
      if (!this.appSettingsService.getCacheStats().isInitialized) {
        return { isMinIO: false };
      }
      const config = this.getS3Configuration();
      return {
        isMinIO: config.isMinIO,
        endpoint: config.isMinIO ? config.endpoint : undefined,
        version: config.isMinIO ? 'Compatible' : undefined,
      };
    } catch {
      return { isMinIO: false };
    }
  }

  /**
   * Refresh S3 configuration from AppSettingsService
   * Useful when configuration changes at runtime
   */
  public async refreshConfiguration(): Promise<void> {
    this.logger.log({
      message: 'Refreshing S3 configuration',
    });
    this.isInitialized = false;
    this.s3Client = null;
    this.initializationPromise = null;
    this.configurationAvailable = false;

    // Check if configuration is now available
    if (await this.hasRequiredConfiguration()) {
      await this.initializeS3Client();
    } else {
      this.logger.warn({
        message: 'S3 configuration still not available after refresh',
      });
    }
  }

  private async streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private debugLog(error: unknown): void {
    if (!this.appSettingsService.getCacheStats().isInitialized) {
      return;
    }

    const isDebugEnabled = this.appSettingsService.getValueWithDefault('DEBUG', false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (isDebugEnabled && (error as any)?.$response) {
      this.logger.debug({
        message: 'S3 raw response',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: (error as any).$response,
      });
    }
  }
}
