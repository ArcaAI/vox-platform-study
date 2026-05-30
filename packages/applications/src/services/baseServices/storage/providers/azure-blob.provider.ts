import { BlobSASPermissions, BlobServiceClient, generateBlobSASQueryParameters, SASProtocol, StorageSharedKeyCredential } from '@azure/storage-blob';
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
  StorageNotSupportedError,
} from './IBlobStorageProvider';

/**
 * Construction config for {@link AzureBlobProvider}. Either a full
 * `connectionString` (preferred — carries the account key for SAS) or an
 * `accountName` + `accountKey` pair must be supplied. Resolved by the factory:
 * `accountName` from AppSettings, secrets from SecretsService.
 */
export interface AzureBlobProviderConfig {
  /** Storage account name (used to build the blob endpoint URL). */
  accountName: string;
  /** Account shared key. Required for SAS presigning when no connection string. */
  accountKey?: string;
  /** Full connection string (alternative to accountName + accountKey). */
  connectionString?: string;
  /** Endpoint suffix; defaults to `core.windows.net` (Azure public cloud). */
  endpointSuffix?: string;
}

/**
 * Azure Storage Blob provider. Maps the abstraction's "bucket" → Azure
 * container. Presigning uses SAS (`generateBlobSASQueryParameters`);
 * pagination uses `listBlobsFlat().byPage({ continuationToken, maxPageSize })`.
 *
 * Note: blob lifecycle management (ILM) is an account-level management-plane
 * operation absent from the `@azure/storage-blob` data SDK, so
 * {@link AzureBlobProvider.setLifecycle} throws {@link StorageNotSupportedError}.
 */
export class AzureBlobProvider implements IBlobStorageProvider {
  readonly provider = StorageProvider.AZURE_BLOB;
  private readonly logger = new Logger(AzureBlobProvider.name);
  private readonly client: BlobServiceClient;
  /** Present only when an account key is known; required for SAS presigning. */
  private readonly sharedKeyCredential?: StorageSharedKeyCredential;

  constructor(config: AzureBlobProviderConfig) {
    const suffix = config.endpointSuffix ?? 'core.windows.net';
    let accountName = config.accountName;
    let accountKey = config.accountKey;

    if (config.connectionString) {
      const parsed = AzureBlobProvider.parseConnectionString(config.connectionString);
      accountName = accountName || parsed.accountName || '';
      accountKey = accountKey ?? parsed.accountKey;
      this.client = BlobServiceClient.fromConnectionString(config.connectionString);
      // Reconstruct a shared key credential so SAS presigning still works.
      if (accountName && accountKey) {
        this.sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
      }
    } else if (accountKey) {
      this.sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
      this.client = new BlobServiceClient(`https://${accountName}.blob.${suffix}`, this.sharedKeyCredential);
    } else {
      throw new Error('AzureBlobProvider requires either a connectionString or accountName + accountKey');
    }
  }

  async putObject(params: PutObjectParams): Promise<void> {
    const blockBlobClient = this.client.getContainerClient(params.bucket).getBlockBlobClient(params.key);
    await blockBlobClient.uploadData(params.body, {
      ...(params.contentType ? { blobHTTPHeaders: { blobContentType: params.contentType } } : {}),
      metadata: params.metadata,
    });
  }

  async getObject(params: GetObjectParams): Promise<Buffer> {
    const blockBlobClient = this.client.getContainerClient(params.bucket).getBlockBlobClient(params.key);
    return blockBlobClient.downloadToBuffer();
  }

  async getObjectStream(params: GetObjectParams): Promise<Readable> {
    const blockBlobClient = this.client.getContainerClient(params.bucket).getBlockBlobClient(params.key);
    const response = await blockBlobClient.download();
    if (!response.readableStreamBody) {
      throw new Error(`Object has no readable stream body: ${params.bucket}/${params.key}`);
    }
    return response.readableStreamBody as Readable;
  }

  async deleteObject(params: DeleteObjectParams): Promise<void> {
    await this.client.getContainerClient(params.bucket).getBlockBlobClient(params.key).deleteIfExists();
  }

  async listObjects(params: ListObjectsParams): Promise<ListObjectsResult> {
    const iterator = this.client
      .getContainerClient(params.bucket)
      .listBlobsFlat({ prefix: params.prefix })
      .byPage({ continuationToken: params.continuationToken, maxPageSize: params.maxKeys });

    const { value } = await iterator.next();
    const blobItems = value?.segment?.blobItems ?? [];

    const objects = blobItems.map((item) => ({
      key: item.name,
      size: item.properties?.contentLength ?? 0,
      lastModified: item.properties?.lastModified,
    }));

    const nextContinuationToken = value?.continuationToken || undefined;

    return {
      objects,
      nextContinuationToken,
      isTruncated: Boolean(nextContinuationToken),
    };
  }

  async presignGet(params: PresignGetParams): Promise<string> {
    const sas = this.buildSas(params.bucket, params.key, BlobSASPermissions.parse('r'), params.expiresInSeconds);
    const blobClient = this.client.getContainerClient(params.bucket).getBlockBlobClient(params.key);
    return `${blobClient.url}?${sas}`;
  }

  async presignPut(params: PresignPutParams): Promise<string> {
    const sas = this.buildSas(params.bucket, params.key, BlobSASPermissions.parse('cw'), params.expiresInSeconds, params.contentType);
    const blobClient = this.client.getContainerClient(params.bucket).getBlockBlobClient(params.key);
    return `${blobClient.url}?${sas}`;
  }

  async createBucket(bucket: string): Promise<void> {
    await this.client.getContainerClient(bucket).createIfNotExists();
  }

  async deleteBucket(bucket: string): Promise<void> {
    await this.client.getContainerClient(bucket).deleteIfExists();
  }

  async bucketExists(bucket: string): Promise<boolean> {
    return this.client.getContainerClient(bucket).exists();
  }

  /**
   * Not supported on the Azure data-plane SDK. Blob lifecycle (ILM) is an
   * account-level management-plane operation — configure it via Azure Resource
   * Manager (`azure-mgmt-storage`) or the portal.
   */
  setLifecycle(bucket: string, rules: LifecycleRule[]): Promise<void> {
    return Promise.reject(
      new StorageNotSupportedError(
        `Azure blob lifecycle management (ILM) is an account-level management-plane operation not available ` +
          `in the @azure/storage-blob data SDK (requested ${rules.length} rule(s) for container '${bucket}'). ` +
          `Configure it via Azure Resource Manager (azure-mgmt-storage) or the Azure portal.`,
      ),
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getProperties();
      return true;
    } catch (error) {
      this.logger.warn({
        message: 'Azure blob storage health check failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private buildSas(bucket: string, key: string, permissions: BlobSASPermissions, expiresInSeconds: number, contentType?: string): string {
    if (!this.sharedKeyCredential) {
      throw new Error(
        'Azure SAS presigning requires a shared key credential ' + '(provide an account key, or a connection string containing AccountKey).',
      );
    }
    const now = Date.now();
    return generateBlobSASQueryParameters(
      {
        containerName: bucket,
        blobName: key,
        permissions,
        startsOn: new Date(now),
        expiresOn: new Date(now + expiresInSeconds * 1000),
        protocol: SASProtocol.Https,
        ...(contentType ? { contentType } : {}),
      },
      this.sharedKeyCredential,
    ).toString();
  }

  private static parseConnectionString(connectionString: string): { accountName?: string; accountKey?: string } {
    const result: { accountName?: string; accountKey?: string } = {};
    for (const segment of connectionString.split(';')) {
      const idx = segment.indexOf('=');
      if (idx === -1) continue;
      const key = segment.slice(0, idx).trim();
      const value = segment.slice(idx + 1).trim();
      if (key === 'AccountName') result.accountName = value;
      else if (key === 'AccountKey') result.accountKey = value;
    }
    return result;
  }
}
