/**
 * BlobStorageProviderFactory Unit Tests
 *
 * The factory's only real logic is provider *selection* by config and caching;
 * the providers themselves are exercised in their own suites. So we mock both
 * provider modules (via vi.hoisted) to (a) avoid pulling real AWS/Azure SDK
 * clients into this test and (b) assert exactly which provider got constructed
 * and with what resolved config.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageProvider } from '@arcaai/types';

const h = vi.hoisted(() => ({
  S3BlobProvider: vi.fn(),
  AzureBlobProvider: vi.fn(),
}));

vi.mock('../s3-blob.provider', () => ({ S3BlobProvider: h.S3BlobProvider }));
vi.mock('../azure-blob.provider', () => ({ AzureBlobProvider: h.AzureBlobProvider }));

import { BlobStorageProviderFactory } from '../blob-storage.provider.factory';
import { S3BlobProvider } from '../s3-blob.provider';
import { AzureBlobProvider } from '../azure-blob.provider';

function makeAppSettings(settings: Record<string, unknown> = {}) {
  return {
    getValueWithDefault: vi.fn((key: string, def: unknown) => (key in settings ? settings[key] : def)),
  } as unknown as Parameters<typeof BlobStorageProviderFactory.prototype.constructor>[0];
}

function makeSecrets(secrets: Record<string, string> = {}) {
  return {
    getSecretOptional: vi.fn(async (key: string) => secrets[key]),
  };
}

// Constructor args are not statically typed here on purpose — the fakes only
// implement the slice of IAppSettingsService / SecretsService the factory uses.
function build(settings: Record<string, unknown>, secrets?: Record<string, string>): BlobStorageProviderFactory {
  return new BlobStorageProviderFactory(makeAppSettings(settings) as any, secrets === undefined ? undefined : (makeSecrets(secrets) as any));
}

describe('BlobStorageProviderFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Regular function expressions (not arrows) so the mocks are constructable
    // via `new`; returning an object makes that object the `new` result.
    h.S3BlobProvider.mockImplementation(function (config: unknown) {
      return { __kind: 's3', config };
    });
    h.AzureBlobProvider.mockImplementation(function (config: unknown) {
      return { __kind: 'azure', config };
    });
  });

  describe('provider selection', () => {
    it('defaults to the S3/MinIO provider when STORAGE_PROVIDER is unset', async () => {
      const factory = build({ S3_ENDPOINT: 'http://localhost:9000', S3_REGION: 'us-east-1' }, { S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' });

      const provider = await factory.getProvider();

      expect(S3BlobProvider).toHaveBeenCalledTimes(1);
      expect(AzureBlobProvider).not.toHaveBeenCalled();
      expect(h.S3BlobProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'http://localhost:9000',
          region: 'us-east-1',
          accessKeyId: 'ak',
          secretAccessKey: 'sk',
          provider: StorageProvider.MINIO,
        }),
      );
      expect((provider as unknown as { __kind: string }).__kind).toBe('s3');
    });

    it('selects AWS_S3 when STORAGE_PROVIDER=aws_s3', async () => {
      const factory = build({ STORAGE_PROVIDER: 'aws_s3', S3_REGION: 'ap-southeast-1' }, { S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' });

      await factory.getProvider();

      expect(h.S3BlobProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: StorageProvider.AWS_S3, region: 'ap-southeast-1' }));
      expect(AzureBlobProvider).not.toHaveBeenCalled();
    });

    it('selects the Azure provider when STORAGE_PROVIDER=azure_blob', async () => {
      const factory = build(
        { STORAGE_PROVIDER: 'azure_blob', AZURE_STORAGE_ACCOUNT: 'acct' },
        { AZURE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=key==', AZURE_STORAGE_ACCOUNT_KEY: 'key==' },
      );

      const provider = await factory.getProvider();

      expect(AzureBlobProvider).toHaveBeenCalledTimes(1);
      expect(S3BlobProvider).not.toHaveBeenCalled();
      expect(h.AzureBlobProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          accountName: 'acct',
          connectionString: 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=key==',
          accountKey: 'key==',
        }),
      );
      expect((provider as unknown as { __kind: string }).__kind).toBe('azure');
    });

    it('is case-insensitive (uppercase AZURE_BLOB)', async () => {
      const factory = build({ STORAGE_PROVIDER: 'AZURE_BLOB', AZURE_STORAGE_ACCOUNT: 'acct' }, { AZURE_STORAGE_ACCOUNT_KEY: 'key==' });

      await factory.getProvider();

      expect(AzureBlobProvider).toHaveBeenCalledTimes(1);
    });

    it('falls back to MinIO on an unknown STORAGE_PROVIDER value', async () => {
      const factory = build({ STORAGE_PROVIDER: 'gcs' }, {});

      await factory.getProvider();

      expect(h.S3BlobProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: StorageProvider.MINIO }));
      expect(AzureBlobProvider).not.toHaveBeenCalled();
    });
  });

  describe('caching', () => {
    it('constructs the provider once and returns the cached instance', async () => {
      const factory = build({}, { S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' });

      const first = await factory.getProvider();
      const second = await factory.getProvider();

      expect(first).toBe(second);
      expect(S3BlobProvider).toHaveBeenCalledTimes(1);
    });
  });

  describe('secret resolution', () => {
    it('resolves S3 credentials via SecretsService', async () => {
      const secrets = makeSecrets({ S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk' });
      const factory = new BlobStorageProviderFactory(makeAppSettings({}) as any, secrets as any);

      await factory.getProvider();

      expect(secrets.getSecretOptional).toHaveBeenCalledWith('S3_ACCESS_KEY');
      expect(secrets.getSecretOptional).toHaveBeenCalledWith('S3_SECRET_KEY');
    });

    it('tolerates a missing SecretsService and defaults credentials to empty strings', async () => {
      const factory = build({}, undefined);

      const provider = await factory.getProvider();

      expect((provider as unknown as { __kind: string }).__kind).toBe('s3');
      expect(h.S3BlobProvider).toHaveBeenCalledWith(expect.objectContaining({ accessKeyId: '', secretAccessKey: '' }));
    });
  });

  /**
   * The SYSTEM row's Vault `credentialsRef` is the PLATFORM credential tier;
   * `S3_ACCESS_KEY` / `S3_SECRET_KEY` are only the documented BOOTSTRAP fallback
   * used before that ref holds a value (`09-infrastructure-devops.md`
   * Tiers).
   *
   * The "did the ref supply anything?" test must therefore consider EVERY field
   * the ref can carry. It originally omitted `secretAccessKey`, so a Vault value
   * carrying only that field scored as empty and the whole ref was discarded in
   * favour of env — a silent downgrade from the Vault tier to the bootstrap tier
   * on a credential path, which is the drift this ticket exists to remove.
 */
  describe('platform credentials — the Vault credentialsRef outranks the env bootstrap tier', () => {
    /** A SYSTEM `TenantStorageConfig` row carrying a Vault path and nothing else. */
    function systemRowRepo(credentialsRef: string) {
      return {
        findSystemDefault: vi.fn().mockResolvedValue({
          provider: 'MINIO',
          endpoint: 'http://minio:9000',
          region: 'us-east-1',
          forcePathStyle: true,
          accountName: null,
          endpointSuffix: null,
          containerPrefix: null,
          credentialsRef,
        }),
        findTenantDefault: vi.fn(),
        findForBucket: vi.fn(),
      };
    }

    function buildWithSystemRow(secrets: Record<string, string>, credentialsRef = 'platform/storage/minio') {
      return new BlobStorageProviderFactory(makeAppSettings({}) as any, makeSecrets(secrets) as any, systemRowRepo(credentialsRef) as any);
    }

    it('uses a credentialsRef that carries BOTH halves of the key pair', async () => {
      const factory = buildWithSystemRow({
        'platform/storage/minio': JSON.stringify({ accessKeyId: 'vault-ak', secretAccessKey: 'vault-sk' }),
        S3_ACCESS_KEY: 'env-ak',
        S3_SECRET_KEY: 'env-sk',
      });

      await factory.getProvider();

      expect(h.S3BlobProvider).toHaveBeenCalledWith(expect.objectContaining({ accessKeyId: 'vault-ak', secretAccessKey: 'vault-sk' }));
    });

    it('uses a credentialsRef that carries ONLY secretAccessKey rather than silently reverting to env', async () => {
      const factory = buildWithSystemRow({
        'platform/storage/minio': JSON.stringify({ secretAccessKey: 'vault-sk' }),
        S3_ACCESS_KEY: 'env-ak',
        S3_SECRET_KEY: 'env-sk',
      });

      await factory.getProvider();

      // The ref spoke, so it IS the platform tier and it wins wholesale. Falling
      // through here would authenticate with an env secret the operator believed
      // they had superseded in Vault.
      expect(h.S3BlobProvider).toHaveBeenCalledWith(expect.objectContaining({ secretAccessKey: 'vault-sk' }));
      expect(h.S3BlobProvider).not.toHaveBeenCalledWith(expect.objectContaining({ secretAccessKey: 'env-sk' }));
    });

    it('still falls back to the env bootstrap tier when the ref holds nothing at all', async () => {
      const factory = buildWithSystemRow({ S3_ACCESS_KEY: 'env-ak', S3_SECRET_KEY: 'env-sk' });

      await factory.getProvider();

      expect(h.S3BlobProvider).toHaveBeenCalledWith(expect.objectContaining({ accessKeyId: 'env-ak', secretAccessKey: 'env-sk' }));
    });
  });
});
