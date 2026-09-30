import { Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'stream';
import { ClsService } from 'nestjs-cls';

import { IActiveUserContext } from '../../../interfaces';
import { IBlobStorageService } from './IBlobStorageService';
import { BlobStorageProviderFactory } from './providers/blob-storage.provider.factory';
import { TenantBucketStorageGate } from './tenant-bucket-storage.gate';
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
  StorageDescriptor,
} from './providers/IBlobStorageProvider';

/**
 * BlobStorageService — the single, provider-agnostic entry point for blob
 * storage. Delegates every call to the {@link IBlobStorageProvider} resolved by
 * {@link BlobStorageProviderFactory}.
 *
 * Tenant-aware: data-plane calls resolve the provider for the
 * current tenant + bucket (per-bucket override → tenant default → global/shared
 * config). With no tenant context (e.g. unit tests, platform jobs) it resolves
 * the global/shared provider, preserving W1 behaviour.
 */
@Injectable()
export class BlobStorageService implements IBlobStorageService {
  private readonly logger = new Logger(BlobStorageService.name);

  constructor(
    private readonly factory: BlobStorageProviderFactory,
    // Optional so W1 direct-construction tests keep working; when absent there
    // is no tenant context, so resolution uses the global/shared provider.
    @Optional() private readonly clsService?: ClsService<IActiveUserContext>,
    // TASK-1025 — tenant-bucket lifecycle checks on every object operation.
    // Optional so direct-construction tests and DB-less graphs keep working.
    @Optional() private readonly gate?: TenantBucketStorageGate,
  ) {}

  private tenantId(): string | null | undefined {
    return this.clsService?.get('tenantId') ?? undefined;
  }

  /** Resolve the provider for the current tenant + (optional) bucket. */
  private provider(bucket?: string): Promise<IBlobStorageProvider> {
    return this.factory.getProviderForBucket(this.tenantId(), bucket);
  }

  async putObject(params: PutObjectParams): Promise<void> {
    const gated = await this.gate?.assertCanWrite(params.bucket, params.body.byteLength);
    await (await this.provider(params.bucket)).putObject(params);
    await this.gate?.recordWrite(gated ?? null, params.body.byteLength);
  }

  async getObject(params: GetObjectParams): Promise<Buffer> {
    await this.gate?.assertAccessible(params.bucket);
    return (await this.provider(params.bucket)).getObject(params);
  }

  async getObjectStream(params: GetObjectParams): Promise<Readable> {
    await this.gate?.assertAccessible(params.bucket);
    return (await this.provider(params.bucket)).getObjectStream(params);
  }

  async deleteObject(params: DeleteObjectParams): Promise<void> {
    const gated = await this.gate?.assertAccessible(params.bucket);
    await (await this.provider(params.bucket)).deleteObject(params);
    await this.gate?.recordDelete(gated ?? null);
  }

  async listObjects(params: ListObjectsParams): Promise<ListObjectsResult> {
    await this.gate?.assertAccessible(params.bucket);
    return (await this.provider(params.bucket)).listObjects(params);
  }

  async presignGet(params: PresignGetParams): Promise<string> {
    await this.gate?.assertAccessible(params.bucket);
    return (await this.provider(params.bucket)).presignGet(params);
  }

  async presignPut(params: PresignPutParams): Promise<string> {
    // The upload size is unknown when the URL is issued: refuse once the tenant is AT its quota.
    await this.gate?.assertCanWrite(params.bucket, 1);
    return (await this.provider(params.bucket)).presignPut(params);
  }

  async createBucket(bucket: string): Promise<void> {
    return (await this.provider(bucket)).createBucket(bucket);
  }

  async deleteBucket(bucket: string): Promise<void> {
    return (await this.provider(bucket)).deleteBucket(bucket);
  }

  async bucketExists(bucket: string): Promise<boolean> {
    return (await this.provider(bucket)).bucketExists(bucket);
  }

  async setLifecycle(bucket: string, rules: LifecycleRule[]): Promise<void> {
    return (await this.provider(bucket)).setLifecycle(bucket, rules);
  }

  async resolveDescriptor(bucket: string): Promise<StorageDescriptor | null> {
    return this.factory.resolveDescriptorForBucket(this.tenantId(), bucket);
  }

  /**
   * Health probe. Returns false (rather than throwing) when the provider can't
   * be resolved — e.g. missing/invalid configuration — so it is safe to wire
   * into a health endpoint. Always probes the global/shared provider.
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await (await this.factory.getProvider()).healthCheck();
    } catch (error) {
      this.logger.warn({
        message: 'Blob storage health check could not resolve a provider',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
