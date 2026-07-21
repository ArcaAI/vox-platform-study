import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { StorageProvider } from '@arcaai/types';
import {
  StorageProviderType,
  StorageTopologyType,
  TenantBucketRepository,
  TenantStorageConfigEntity,
  TenantStorageConfigRepository,
} from '@arcaai/domains';
import { IAppSettingsService } from '../../_meta';
import { SecretsService } from '../../_meta/secrets';
import { AzureBlobProvider } from './azure-blob.provider';
import { IBlobStorageProvider, StorageDescriptor } from './IBlobStorageProvider';
import { S3BlobProvider } from './s3-blob.provider';

/** Shape of the JSON value stored at a DEDICATED config's `credentialsRef`. */
interface ResolvedStorageCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  connectionString?: string;
  accountKey?: string;
}

/**
 * Selects and constructs the active {@link IBlobStorageProvider} from global
 * configuration, then caches the instance for the process lifetime.
 *
 * Config keys (mirrors the existing S3Service split — non-secrets via
 * AppSettings, credentials via SecretsService):
 *
 * | Key                              | Source        | Purpose                                                        |
 * | -------------------------------- | ------------- | -------------------------------------------------------------- |
 * | `STORAGE_PROVIDER`               | AppSettings   | `minio` (default) \| `aws_s3` \| `azure_blob`                  |
 * | `S3_ENDPOINT`                    | AppSettings   | S3/MinIO endpoint URL (omit for real AWS S3)                   |
 * | `S3_REGION`                      | AppSettings   | S3 region (default `us-east-1`)                                |
 * | `S3_FORCE_PATH_STYLE`            | AppSettings   | Force path-style URLs (default `true`, required for MinIO)     |
 * | `S3_ACCESS_KEY`                  | SecretsService| S3 access key id                                               |
 * | `S3_SECRET_KEY`                  | SecretsService| S3 secret access key                                           |
 * | `AZURE_STORAGE_ACCOUNT`          | AppSettings   | Azure storage account name                                     |
 * | `AZURE_STORAGE_ENDPOINT_SUFFIX`  | AppSettings   | Azure endpoint suffix (default `core.windows.net`)             |
 * | `AZURE_STORAGE_CONNECTION_STRING`| SecretsService| Azure connection string (preferred — carries the account key) |
 * | `AZURE_STORAGE_ACCOUNT_KEY`      | SecretsService| Azure shared account key (alternative to connection string)   |
 *
 * Unknown / unset `STORAGE_PROVIDER` values fall back to MinIO.
 */
@Injectable()
export class BlobStorageProviderFactory {
  private readonly logger = new Logger(BlobStorageProviderFactory.name);
  private providerPromise?: Promise<IBlobStorageProvider>;

  /**
   * Per-(tenant,bucket) provider cache for DEDICATED configs and resolved
   * SHARED fall-throughs. Bounded FIFO to avoid unbounded growth across many
   * tenants; invalidated by {@link invalidate} on config CRUD.
   */
  private readonly tenantProviderCache = new Map<string, Promise<IBlobStorageProvider>>();
  private readonly maxTenantCacheEntries = 256;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    // Optional so direct-construction unit tests and secrets-less environments
    // still work; on a miss, credentials default to '' (same as S3Service).
    @Optional() @Inject(SecretsService) private readonly secrets?: SecretsService,
    // Optional so W1's direct-construction tests and non-DB graphs keep working;
    // when absent, per-tenant resolution transparently falls back to the global
    // (shared) provider. Wired in via CoreDatabaseModule in BlobStorageModule.
    @Optional() private readonly configRepo?: TenantStorageConfigRepository,
    @Optional() private readonly bucketRepo?: TenantBucketRepository,
  ) {}

  /** Resolve (and cache) the configured provider. Construction happens once. */
  getProvider(): Promise<IBlobStorageProvider> {
    if (!this.providerPromise) {
      this.providerPromise = this.buildProvider().catch((error) => {
        // Don't cache a failed build — let the next caller retry.
        this.providerPromise = undefined;
        throw error;
      });
    }
    return this.providerPromise;
  }

  /** The provider type selected by `STORAGE_PROVIDER` (default MinIO). */
  resolveProviderType(): StorageProvider {
    const raw = this.appSettings.getValueWithDefault<string>('STORAGE_PROVIDER', StorageProvider.MINIO);
    const normalized = String(raw).trim().toLowerCase();

    switch (normalized) {
      case StorageProvider.MINIO:
        return StorageProvider.MINIO;
      case StorageProvider.AWS_S3:
        return StorageProvider.AWS_S3;
      case StorageProvider.AZURE_BLOB:
        return StorageProvider.AZURE_BLOB;
      default:
        this.logger.warn({
          message: 'Unknown STORAGE_PROVIDER value; defaulting to MinIO',
          value: raw,
        });
        return StorageProvider.MINIO;
    }
  }

  private async buildProvider(): Promise<IBlobStorageProvider> {
    const selected = this.resolveProviderType();
    const provider = selected === StorageProvider.AZURE_BLOB ? await this.buildAzureProvider() : await this.buildS3Provider(selected);

    this.logger.log({ message: 'Blob storage provider initialized', provider: provider.provider });
    return provider;
  }

  private async buildS3Provider(provider: StorageProvider): Promise<IBlobStorageProvider> {
    const endpoint = this.appSettings.getValueWithDefault<string>('S3_ENDPOINT', '');
    const region = this.appSettings.getValueWithDefault<string>('S3_REGION', 'us-east-1');
    const forcePathStyle = this.appSettings.getValueWithDefault<boolean>('S3_FORCE_PATH_STYLE', true);
    const accessKeyId = (await this.secrets?.getSecretOptional('S3_ACCESS_KEY')) ?? '';
    const secretAccessKey = (await this.secrets?.getSecretOptional('S3_SECRET_KEY')) ?? '';

    return new S3BlobProvider({
      ...(endpoint ? { endpoint } : {}),
      region,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      provider,
    });
  }

  private async buildAzureProvider(): Promise<IBlobStorageProvider> {
    const accountName = this.appSettings.getValueWithDefault<string>('AZURE_STORAGE_ACCOUNT', '');
    const endpointSuffix = this.appSettings.getValueWithDefault<string>('AZURE_STORAGE_ENDPOINT_SUFFIX', 'core.windows.net');
    const connectionString = await this.secrets?.getSecretOptional('AZURE_STORAGE_CONNECTION_STRING');
    const accountKey = await this.secrets?.getSecretOptional('AZURE_STORAGE_ACCOUNT_KEY');

    return new AzureBlobProvider({
      accountName,
      endpointSuffix,
      ...(connectionString ? { connectionString } : {}),
      ...(accountKey ? { accountKey } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Per-tenant / per-bucket resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the active provider for a tenant's bucket. Resolution order:
   *   per-bucket override → tenant default → global/shared config.
   *
   * Falls back to the global {@link getProvider} when there is no tenant
   * context or no DB access (so it degrades to W1 behaviour). Results are
   * cached per `(tenantId, bucketName)`; bust with {@link invalidate}.
   */
  getProviderForBucket(tenantId: string | null | undefined, bucketName?: string): Promise<IBlobStorageProvider> {
    if (!tenantId || !this.configRepo) {
      return this.getProvider();
    }

    const cacheKey = `${tenantId}::${bucketName ?? ''}`;
    const cached = this.tenantProviderCache.get(cacheKey);
    if (cached) return cached;

    const built = this.resolveProviderForBucket(tenantId, bucketName).catch((error) => {
      // Don't cache a failed resolution — let the next caller retry.
      this.tenantProviderCache.delete(cacheKey);
      throw error;
    });
    this.setTenantCache(cacheKey, built);
    return built;
  }

  /**
   * Build a serializable {@link StorageDescriptor} for a tenant's bucket, for
   * propagation to out-of-process workers (Python STT) so they can read/write
   * the tenant's DEDICATED backend directly.
   *
   * Returns `null` when the resolved config is SHARED or absent — the worker
   * should then fall back to its own env-default client addressed by the bucket
   * name. Consequently credentials are only ever emitted for DEDICATED tenants.
   */
  async resolveDescriptorForBucket(tenantId: string | null | undefined, bucketName: string): Promise<StorageDescriptor | null> {
    if (!tenantId || !this.configRepo) return null;

    const config = await this.resolveConfig(tenantId, bucketName);
    if (!config || config.topology === StorageTopologyType.SHARED) {
      return null;
    }

    const creds = await this.loadCredentials(config.credentialsRef ?? undefined);

    if (config.provider === StorageProviderType.AZURE_BLOB) {
      return {
        provider: 'azure_blob',
        bucket: bucketName,
        ...(config.accountName ? { account_name: config.accountName } : {}),
        endpoint_suffix: config.endpointSuffix ?? 'core.windows.net',
        ...(creds.connectionString ? { connection_string: creds.connectionString } : {}),
        ...(creds.accountKey ? { account_key: creds.accountKey } : {}),
      };
    }

    return {
      provider: config.provider === StorageProviderType.AWS_S3 ? 'aws_s3' : 'minio',
      bucket: bucketName,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region ?? 'us-east-1',
      force_path_style: config.forcePathStyle ?? true,
      access_key_id: creds.accessKeyId ?? '',
      secret_access_key: creds.secretAccessKey ?? '',
    };
  }

  /** Clear cached providers for a tenant (or all tenants when omitted). */
  invalidate(tenantId?: string): void {
    if (!tenantId) {
      this.tenantProviderCache.clear();
      return;
    }
    const prefix = `${tenantId}::`;
    for (const key of [...this.tenantProviderCache.keys()]) {
      if (key.startsWith(prefix)) this.tenantProviderCache.delete(key);
    }
  }

  private async resolveProviderForBucket(tenantId: string, bucketName?: string): Promise<IBlobStorageProvider> {
    const config = await this.resolveConfig(tenantId, bucketName);
    if (!config || config.topology === StorageTopologyType.SHARED) {
      return this.getProvider();
    }
    return this.buildFromEntity(config);
  }

  private async resolveConfig(tenantId: string, bucketName?: string): Promise<TenantStorageConfigEntity | null> {
    if (!this.configRepo) return null;

    // Per-bucket override: map the physical bucket name → its TenantBucket id,
    // then look for a bucket-scoped config row.
    if (bucketName && this.bucketRepo) {
      const bucket = await this.bucketRepo.findByName(bucketName);
      if (bucket && bucket.tenantId === tenantId) {
        const forBucket = await this.configRepo.findForBucket(tenantId, bucket.id);
        if (forBucket) return forBucket;
      }
    }

    return this.configRepo.findTenantDefault(tenantId);
  }

  private async buildFromEntity(config: TenantStorageConfigEntity): Promise<IBlobStorageProvider> {
    const creds = await this.loadCredentials(config.credentialsRef ?? undefined);

    if (config.provider === StorageProviderType.AZURE_BLOB) {
      return new AzureBlobProvider({
        accountName: config.accountName ?? '',
        endpointSuffix: config.endpointSuffix ?? 'core.windows.net',
        ...(creds.connectionString ? { connectionString: creds.connectionString } : {}),
        ...(creds.accountKey ? { accountKey: creds.accountKey } : {}),
      });
    }

    const provider = config.provider === StorageProviderType.AWS_S3 ? StorageProvider.AWS_S3 : StorageProvider.MINIO;
    return new S3BlobProvider({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region ?? 'us-east-1',
      accessKeyId: creds.accessKeyId ?? '',
      secretAccessKey: creds.secretAccessKey ?? '',
      forcePathStyle: config.forcePathStyle ?? true,
      provider,
    });
  }

  private async loadCredentials(ref?: string): Promise<ResolvedStorageCredentials> {
    if (!ref || !this.secrets) return {};
    const raw = await this.secrets.getSecretOptional(ref);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as ResolvedStorageCredentials;
    } catch {
      this.logger.warn({ message: 'Storage credentialsRef value is not valid JSON; ignoring', ref });
      return {};
    }
  }

  private setTenantCache(key: string, value: Promise<IBlobStorageProvider>): void {
    if (this.tenantProviderCache.size >= this.maxTenantCacheEntries) {
      const oldest = this.tenantProviderCache.keys().next().value;
      if (oldest !== undefined) this.tenantProviderCache.delete(oldest);
    }
    this.tenantProviderCache.set(key, value);
  }
}
