import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';

import { IBlobStorageService } from './IBlobStorageService';
import { BlobStorageProviderFactory } from './providers/blob-storage.provider.factory';
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
} from './providers/IBlobStorageProvider';

/**
 * BlobStorageService — the single, provider-agnostic entry point for blob
 * storage. Delegates every call to the {@link IBlobStorageProvider} resolved by
 * {@link BlobStorageProviderFactory} (S3/MinIO or Azure, per `STORAGE_PROVIDER`).
 *
 * Additive in W1: nothing is wired to consume this yet — the existing S3Service
 * is untouched. A later wave migrates consumers onto this service.
 */
@Injectable()
export class BlobStorageService implements IBlobStorageService {
  private readonly logger = new Logger(BlobStorageService.name);

  constructor(private readonly factory: BlobStorageProviderFactory) {}

  private provider(): Promise<IBlobStorageProvider> {
    return this.factory.getProvider();
  }

  async putObject(params: PutObjectParams): Promise<void> {
    return (await this.provider()).putObject(params);
  }

  async getObject(params: GetObjectParams): Promise<Buffer> {
    return (await this.provider()).getObject(params);
  }

  async getObjectStream(params: GetObjectParams): Promise<Readable> {
    return (await this.provider()).getObjectStream(params);
  }

  async deleteObject(params: DeleteObjectParams): Promise<void> {
    return (await this.provider()).deleteObject(params);
  }

  async listObjects(params: ListObjectsParams): Promise<ListObjectsResult> {
    return (await this.provider()).listObjects(params);
  }

  async presignGet(params: PresignGetParams): Promise<string> {
    return (await this.provider()).presignGet(params);
  }

  async presignPut(params: PresignPutParams): Promise<string> {
    return (await this.provider()).presignPut(params);
  }

  async createBucket(bucket: string): Promise<void> {
    return (await this.provider()).createBucket(bucket);
  }

  async deleteBucket(bucket: string): Promise<void> {
    return (await this.provider()).deleteBucket(bucket);
  }

  async bucketExists(bucket: string): Promise<boolean> {
    return (await this.provider()).bucketExists(bucket);
  }

  async setLifecycle(bucket: string, rules: LifecycleRule[]): Promise<void> {
    return (await this.provider()).setLifecycle(bucket, rules);
  }

  /**
   * Health probe. Returns false (rather than throwing) when the provider can't
   * be resolved — e.g. missing/invalid configuration — so it is safe to wire
   * into a health endpoint.
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await (await this.provider()).healthCheck();
    } catch (error) {
      this.logger.warn({
        message: 'Blob storage health check could not resolve a provider',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
