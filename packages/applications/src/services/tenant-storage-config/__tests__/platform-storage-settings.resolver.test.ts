// lane A.1 — the `db-config` read lane for `storage.platformDefault.*`.
//
// The resolver is a DISPATCH layer, not a second store: it reads the SYSTEM
// `TenantStorageConfig` row through the repository that already owns it and
// folds it through the SAME pure cascade the upload path uses
// (`resolvePlatformStorageConfig`). What is asserted here is therefore the
// CONTRACT, not the cascade arithmetic (that has its own test):
//
//   • which tier answered is reported honestly (`sourceScope`);
//   • a backend ERROR propagates — it is never disguised as "no value";
//   • an absent value returns `undefined` so the CALLER applies the declared
//     `failMode` (this class never substitutes a default itself);
//   • the enum is served in the vocabulary the DESCRIPTOR declares (lowercase),
//     not the Prisma spelling.

import { StorageProviderType, type TenantStorageConfigEntity, type TenantStorageConfigRepository } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import type { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { PlatformStorageSettingsResolver } from '../platform-storage-settings.resolver';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function systemRow(over: Partial<TenantStorageConfigEntity> = {}): TenantStorageConfigEntity {
  return {
    provider: StorageProviderType.MINIO,
    endpoint: 'http://minio.internal:9000',
    region: 'ap-south-1',
    forcePathStyle: true,
    accountName: null,
    endpointSuffix: null,
    containerPrefix: 'hope-',
    credentialsRef: 'platform/storage/minio',
    ...over,
  } as unknown as TenantStorageConfigEntity;
}

function build(opts: { rows?: TenantStorageConfigEntity[]; throws?: Error; appSettings?: Record<string, unknown> } = {}) {
  const repo = {
    findAllTenantDefaults: vi.fn(async (tenantId: string) => {
      expect(tenantId).toBe(SYSTEM_TENANT_ID);
      if (opts.throws) throw opts.throws;
      return opts.rows ?? [];
    }),
  } as unknown as TenantStorageConfigRepository;

  const appSettings = {
    getValueWithDefault: vi.fn((key: string, fallback: unknown) => (opts.appSettings && key in opts.appSettings ? opts.appSettings[key] : fallback)),
  } as unknown as IAppSettingsService;

  return { resolver: new PlatformStorageSettingsResolver(repo, appSettings), repo };
}

describe('PlatformStorageSettingsResolver', () => {
  it('claims exactly the storage.platformDefault.* non-secret keys', () => {
    const { resolver } = build();
    expect(resolver.resolves('storage.platformDefault.provider')).toBe(true);
    expect(resolver.resolves('storage.platformDefault.region')).toBe(true);
    // The credentials pointer is `vault-kv` / `secret` — it must never be
    // claimed by a config read surface, even though it shares the prefix.
    expect(resolver.resolves('storage.platformDefault.credentials')).toBe(false);
    expect(resolver.resolves('models.harness.judge')).toBe(false);
  });

  it('serves the SYSTEM row and reports `system` as the tier that answered', async () => {
    const { resolver } = build({ rows: [systemRow()] });

    await expect(resolver.resolve('storage.platformDefault.region')).resolves.toEqual({ value: 'ap-south-1', sourceScope: 'system' });
    await expect(resolver.resolve('storage.platformDefault.endpoint')).resolves.toEqual({
      value: 'http://minio.internal:9000',
      sourceScope: 'system',
    });
    await expect(resolver.resolve('storage.platformDefault.forcePathStyle')).resolves.toEqual({ value: true, sourceScope: 'system' });
    await expect(resolver.resolve('storage.platformDefault.containerPrefix')).resolves.toEqual({ value: 'hope-', sourceScope: 'system' });
  });

  it('serves the provider in the DESCRIPTOR vocabulary, not the Prisma enum spelling', async () => {
    const { resolver } = build({ rows: [systemRow({ provider: StorageProviderType.AZURE_BLOB } as Partial<TenantStorageConfigEntity>)] });
    await expect(resolver.resolve('storage.platformDefault.provider')).resolves.toEqual({ value: 'azure_blob', sourceScope: 'system' });
  });

  it('widens to the GlobalSetting tier when no SYSTEM row exists', async () => {
    const { resolver } = build({ appSettings: { STORAGE_PROVIDER: 'aws_s3', S3_ENDPOINT: 'https://s3.amazonaws.com', S3_REGION: 'eu-west-1' } });
    await expect(resolver.resolve('storage.platformDefault.provider')).resolves.toEqual({ value: 'aws_s3', sourceScope: 'app-settings' });
    await expect(resolver.resolve('storage.platformDefault.region')).resolves.toEqual({ value: 'eu-west-1', sourceScope: 'app-settings' });
  });

  it('reports the env bootstrap tier as `env-bootstrap`, never as a DB answer', async () => {
    const { resolver } = build();
    const provider = await resolver.resolve('storage.platformDefault.provider');
    expect(provider).toEqual({ value: 'minio', sourceScope: 'env-bootstrap' });
  });

  it('serves the MINIO_* env bootstrap tier when no row and no GlobalSetting answer', async () => {
    // `.env.test` sets `MINIO_ENDPOINT`, which is precisely the documented
    // first-boot/pre-seed fallback — so it MUST answer, and must be labelled
    // as the bootstrap tier rather than as a stored value.
    vi.stubEnv('MINIO_ENDPOINT', 'localhost:9999');
    vi.stubEnv('MINIO_USE_SSL', 'false');
    try {
      const { resolver } = build();
      await expect(resolver.resolve('storage.platformDefault.endpoint')).resolves.toEqual({
        value: 'http://localhost:9999',
        sourceScope: 'env-bootstrap',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns undefined for an EMPTY value so the caller applies the declared failMode', async () => {
    vi.stubEnv('MINIO_ENDPOINT', '');
    try {
      const { resolver } = build();
      // No SYSTEM row, no app settings, no MINIO_* — the endpoint and the prefix
      // genuinely have no answer at any tier. Reporting `''`/`null` as a value
      // would make "unset" indistinguishable from "deliberately empty".
      await expect(resolver.resolve('storage.platformDefault.endpoint')).resolves.toBeUndefined();
      await expect(resolver.resolve('storage.platformDefault.containerPrefix')).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('PROPAGATES a backend error instead of reporting absence', async () => {
    const { resolver } = build({ throws: new Error('connection terminated unexpectedly') });
    // The load-bearing property: an unreachable database must never be
    // laundered into "the platform has no opinion", which would silently hand
    // every caller the descriptor default.
    await expect(resolver.resolve('storage.platformDefault.region')).rejects.toThrow('connection terminated unexpectedly');
  });
});
