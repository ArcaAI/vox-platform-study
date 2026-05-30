import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger } from '@nestjs/common';
import { Readable } from 'stream';

import { StorageProvider } from '@arcaai/types';
import {
  DeleteObjectParams,
  GetObjectParams,
  IBlobStorageProvider,
  LifecycleRule,
  ListObjectsParams,
  ListObjectsResult,
  PresignGetParams,
  PresignPutParams,
  PutObjectParams,
} from './IBlobStorageProvider';

/**
 * Construction config for {@link S3BlobProvider}. Non-secret values come from
 * AppSettings, credentials from SecretsService — resolved by the factory.
 */
export interface S3BlobProviderConfig {
  /** S3 endpoint URL. Omit for real AWS S3; set for MinIO/custom endpoints. */
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for MinIO; defaults to true (matches the existing S3Service). */
  forcePathStyle?: boolean;
  /** Reported via {@link IBlobStorageProvider.provider}; defaults to MINIO. */
  provider?: StorageProvider;
}

/**
 * S3-compatible blob provider. Backs both AWS S3 and MinIO via endpoint +
 * `forcePathStyle`. Presigning uses `@aws-sdk/s3-request-presigner`;
 * pagination uses `ListObjectsV2Command` + `ContinuationToken`.
 */
export class S3BlobProvider implements IBlobStorageProvider {
  readonly provider: StorageProvider;
  private readonly logger = new Logger(S3BlobProvider.name);
  private readonly client: S3Client;

  constructor(config: S3BlobProviderConfig) {
    this.provider = config.provider ?? StorageProvider.MINIO;
    this.client = new S3Client({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    });
  }

  async putObject(params: PutObjectParams): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
        Metadata: params.metadata,
      }),
    );
  }

  async getObject(params: GetObjectParams): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: params.bucket, Key: params.key }));
    if (!response.Body) {
      throw new Error(`Object not found: ${params.bucket}/${params.key}`);
    }
    return this.streamToBuffer(response.Body as unknown as NodeJS.ReadableStream);
  }

  async getObjectStream(params: GetObjectParams): Promise<Readable> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: params.bucket, Key: params.key }));
    if (!response.Body) {
      throw new Error(`Object not found: ${params.bucket}/${params.key}`);
    }
    return response.Body as unknown as Readable;
  }

  async deleteObject(params: DeleteObjectParams): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: params.bucket, Key: params.key }));
  }

  async listObjects(params: ListObjectsParams): Promise<ListObjectsResult> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: params.bucket,
        Prefix: params.prefix,
        ContinuationToken: params.continuationToken,
        MaxKeys: params.maxKeys,
      }),
    );

    const objects = (response.Contents ?? []).map((item) => ({
      key: item.Key ?? '',
      size: item.Size ?? 0,
      lastModified: item.LastModified,
    }));

    return {
      objects,
      nextContinuationToken: response.NextContinuationToken,
      isTruncated: response.IsTruncated ?? false,
    };
  }

  async presignGet(params: PresignGetParams): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: params.bucket, Key: params.key }), {
      expiresIn: params.expiresInSeconds,
    });
  }

  async presignPut(params: PresignPutParams): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: params.bucket, Key: params.key, ContentType: params.contentType }), {
      expiresIn: params.expiresInSeconds,
    });
  }

  async createBucket(bucket: string): Promise<void> {
    await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  async deleteBucket(bucket: string): Promise<void> {
    await this.client.send(new DeleteBucketCommand({ Bucket: bucket }));
  }

  async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (error as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
        return false;
      }
      throw error;
    }
  }

  async setLifecycle(bucket: string, rules: LifecycleRule[]): Promise<void> {
    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: rules.map((rule) => ({
            ID: rule.id,
            Filter: { Prefix: rule.prefix ?? '' },
            Status: rule.enabled ? 'Enabled' : 'Disabled',
            ...(rule.expirationDays !== undefined ? { Expiration: { Days: rule.expirationDays } } : {}),
          })),
        },
      }),
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.send(new ListBucketsCommand({}));
      return true;
    } catch (error) {
      this.logger.warn({
        message: 'S3 blob storage health check failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}
