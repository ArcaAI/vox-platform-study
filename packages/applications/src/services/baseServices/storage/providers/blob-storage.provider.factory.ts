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
import { PlatformStorageConfig, PlatformStorageSource, resolvePlatformStorageConfig } from '../../../tenant-storage-config/platform-storage-config';
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

  /** Last platform-config tier logged, so the fallback WARN fires once, not per build. */
  private loggedPlatformSource?: PlatformStorageSource;

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

  /**
   * Resolve the PLATFORM-default configuration — steps 3 and 4 of the
   * `TenantStorageConfig` resolution order: the SYSTEM-tenant row, then the
   * BOOTSTRAP env fallback (`AppSettings S3_*`, then raw `MINIO_*`).
   *
   * Reading the SYSTEM row here — rather than only at boot from env — is what
   * makes a platform storage change take effect with no redeploy: the admin
   * write busts this cache via {@link invalidatePlatform}.
   */
  private async resolvePlatformConfig(): Promise<PlatformStorageConfig> {
    // `findSystemDefault` swallows lookup errors and returns null, so a DB
    // hiccup degrades to the env tier rather than taking uploads down.
    const systemRow = (await this.configRepo?.findSystemDefault()) ?? null;

    return resolvePlatformStorageConfig({
      systemRow,
      appSettings: {
        STORAGE_PROVIDER: this.appSettings.getValueWithDefault<string>('STORAGE_PROVIDER', ''),
        S3_ENDPOINT: this.appSettings.getValueWithDefault<string>('S3_ENDPOINT', ''),
        S3_REGION: this.appSettings.getValueWithDefault<string>('S3_REGION', ''),
        S3_FORCE_PATH_STYLE: this.appSettings.getValueWithDefault<boolean>('S3_FORCE_PATH_STYLE', true),
        AZURE_STORAGE_ACCOUNT: this.appSettings.getValueWithDefault<string>('AZURE_STORAGE_ACCOUNT', ''),
        AZURE_STORAGE_ENDPOINT_SUFFIX: this.appSettings.getValueWithDefault<string>('AZURE_STORAGE_ENDPOINT_SUFFIX', ''),
      },
      env: process.env,
    });
  }

  private async buildProvider(): Promise<IBlobStorageProvider> {
    const config = await this.resolvePlatformConfig();
    this.logPlatformSource(config.source);

    const provider = config.provider === StorageProviderType.AZURE_BLOB ? await this.buildAzureProvider(config) : await this.buildS3Provider(config);

    this.logger.log({
      message: 'Blob storage provider initialized',
      provider: provider.provider,
      configSource: config.source,
    });
    return provider;
  }

  /**
   * Log the tier that supplied the platform configuration exactly ONCE per
   * distinct tier (every fallback is observable, and an
   * operator can tell whether the DB row or the env bootstrap is live).
   */
  private logPlatformSource(source: PlatformStorageSource): void {
    if (this.loggedPlatformSource === source) return;
    this.loggedPlatformSource = source;

    if (source === 'system-row') {
      this.logger.log({ message: 'Platform storage config resolved from the SYSTEM TenantStorageConfig row', source });
      return;
    }
    this.logger.warn({
      message:
        'Platform storage config resolved from the BOOTSTRAP env fallback — the SYSTEM TenantStorageConfig row is missing. ' +
        'Run the storage seed so the platform default becomes admin-manageable.',
      source,
    });
  }

  private async buildS3Provider(config: PlatformStorageConfig): Promise<IBlobStorageProvider> {
    const creds = await this.loadPlatformCredentials(config.credentialsRef);
    const provider = config.provider === StorageProviderType.AWS_S3 ? StorageProvider.AWS_S3 : StorageProvider.MINIO;

    return new S3BlobProvider({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region,
      accessKeyId: creds.accessKeyId ?? '',
      secretAccessKey: creds.secretAccessKey ?? '',
      forcePathStyle: config.forcePathStyle,
      provider,
    });
  }

  private async buildAzureProvider(config: PlatformStorageConfig): Promise<IBlobStorageProvider> {
    const creds = await this.loadPlatformCredentials(config.credentialsRef);
    const connectionString = creds.connectionString ?? (await this.secrets?.getSecretOptional('AZURE_STORAGE_CONNECTION_STRING'));
    const accountKey = creds.accountKey ?? (await this.secrets?.getSecretOptional('AZURE_STORAGE_ACCOUNT_KEY'));

    return new AzureBlobProvider({
      accountName: config.accountName,
      endpointSuffix: config.endpointSuffix,
      ...(connectionString ? { connectionString } : {}),
      ...(accountKey ? { accountKey } : {}),
    });
  }

  /**
   * Platform credentials: the SYSTEM row's Vault `credentialsRef` first, then
   * the pre-existing `S3_ACCESS_KEY` / `S3_SECRET_KEY` secrets. The second step
   * is what keeps a dev box (`SECRETS_PROVIDER=env`, no Vault kv-v2 entry)
   * working unchanged after the SYSTEM row is seeded with a `credentialsRef`.
   */
  private async loadPlatformCredentials(credentialsRef: string | null): Promise<ResolvedStorageCredentials> {
    const fromRef = await this.loadCredentials(credentialsRef ?? undefined);
    // EVERY field the ref can carry counts as "the Vault tier spoke". Omitting
    // one (this test used to skip `secretAccessKey`) turns a partial Vault value
    // into a silent downgrade to the env bootstrap tier — the platform would
    // authenticate with an env secret the operator believed they had superseded.
    if (fromRef.accessKeyId || fromRef.secretAccessKey || fromRef.connectionString || fromRef.accountKey) {
      return fromRef;
    }
    return {
      accessKeyId: (await this.secrets?.getSecretOptional('S3_ACCESS_KEY')) ?? '',
      secretAccessKey: (await this.secrets?.getSecretOptional('S3_SECRET_KEY')) ?? '',
    };
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

  /**
   * Clear the cached PLATFORM provider so the next file operation re-resolves
   * the SYSTEM `TenantStorageConfig` row. Also clears every tenant entry,
   * because a SHARED tenant/bucket config resolves THROUGH the platform
   * provider — leaving those cached would keep serving the old backend.
   *
   * This is what makes "change the SYSTEM row, no redeploy" true.
   */
  invalidatePlatform(): void {
    this.providerPromise = undefined;
    this.loggedPlatformSource = undefined;
    this.tenantProviderCache.clear();
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
