import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { StorageProvider } from '@arcaai/types';
import { IAppSettingsService } from '../../_meta';
import { SecretsService } from '../../_meta/secrets';
import { AzureBlobProvider } from './azure-blob.provider';
import { IBlobStorageProvider } from './IBlobStorageProvider';
import { S3BlobProvider } from './s3-blob.provider';

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

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    // Optional so direct-construction unit tests and secrets-less environments
    // still work; on a miss, credentials default to '' (same as S3Service).
    @Optional() @Inject(SecretsService) private readonly secrets?: SecretsService,
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
}
