/**
 * The S3 readiness gate must consult SecretsService,
 * not plaintext `GlobalSetting` rows.
 *
 * `seed/06-stt.ts` seeded `S3_ACCESS_KEY` / `S3_SECRET_KEY` as PLAINTEXT
 * `GlobalSetting` rows (secrets never sit in a DB column). The credential VALUES were already
 * migrated to `SecretsService.getSecretSync()` (see `getS3Configuration`), so
 * those rows no longer supply anything the client uses — but
 * `hasRequiredConfiguration()` still gated readiness on their PRESENCE in the
 * AppSettings cache.
 *
 * That coupling is why the rows could not simply be deleted: removing them
 * would have made a correctly-configured box (credentials in Vault kv-v2, or in
 * the environment under `SECRETS_PROVIDER=env`) report "configuration missing"
 * and silently skip S3 initialisation.
 *
 * The gate must therefore ask the same source the client reads from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Service } from '../s3.service';
import type { IAppSettingsService } from '../../../_meta/';

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    send = vi.fn();
  }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    ListObjectsV2Command: vi.fn(),
    CopyObjectCommand: vi.fn(),
    ListBucketsCommand: vi.fn(),
    CreateBucketCommand: vi.fn(),
    DeleteBucketCommand: vi.fn(),
  };
});

/** AppSettings WITHOUT any credential rows — the post-migration shape. */
const appSettingsWithoutCredentials = (): IAppSettingsService => {
  const settings: Record<string, unknown> = {
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_PUBLIC_BUCKET: 'public-bucket',
    S3_PRIVATE_BUCKET: 'private-bucket',
    S3_FORCE_PATH_STYLE: true,
  };
  return {
    getCacheStats: vi.fn().mockReturnValue({ isInitialized: true }),
    hasSetting: vi.fn((key: string) => key in settings),
    getValueFromCache: vi.fn((key: string) => settings[key] ?? null),
    getValueWithDefault: vi.fn((key: string, dflt: unknown) => settings[key] ?? dflt),
  } as unknown as IAppSettingsService;
};

const secretsMock = (values: Record<string, string | undefined>) => ({
  getSecretSync: vi.fn((key: string) => values[key]),
  // The readiness gate resolves through the ASYNC `getSecretOptional`
  // change A) — `getSecretSync` is cache-only and returns undefined on any miss,
  // which left the gate permanently false. This mock stubbed only the sync form,
  // so after that change the gate resolved no credentials and init failed with
  // "S3_ENDPOINT must be a valid URL". Both forms are stubbed from the same map
  // so the test covers the real call path.
  getSecretOptional: vi.fn(async (key: string) => values[key]),
});

describe('S3Service — readiness gate reads credentials from SecretsService (G4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes when credentials come from SecretsService and NO GlobalSetting rows exist', async () => {
    const appSettings = appSettingsWithoutCredentials();
    const secrets = secretsMock({ S3_ACCESS_KEY: 'minio_admin', S3_SECRET_KEY: 'minio_admin' });
    const service = new S3Service(appSettings, secrets as never);

    await service.onModuleInit();

    await expect(service.isConfigured()).resolves.toBe(true);
    // The gate must not have consulted the (now deleted) credential rows.
    expect(appSettings.hasSetting).not.toHaveBeenCalledWith('S3_ACCESS_KEY');
    expect(appSettings.hasSetting).not.toHaveBeenCalledWith('S3_SECRET_KEY');
  });

  it('does NOT initialize when the secret is absent, even though the endpoint row exists', async () => {
    const appSettings = appSettingsWithoutCredentials();
    const secrets = secretsMock({ S3_ACCESS_KEY: undefined, S3_SECRET_KEY: undefined });
    const service = new S3Service(appSettings, secrets as never);

    await service.onModuleInit();

    await expect(service.isConfigured()).resolves.toBe(false);
  });
});
