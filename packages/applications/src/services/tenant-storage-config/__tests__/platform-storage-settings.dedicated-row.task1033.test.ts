// TASK-1033 T3 — the catalog must report what the dedicated SYSTEM `TenantStorageConfig` row
// actually STORES for each `storage.platformDefault.*` key, with the row version, instead of the
// false "code default · no row stored". `dedicatedRowValues()` is that read: the row only — never
// the app-settings / env tiers below it, which are not "stored on the dedicated row".
import { StorageProviderType, type TenantStorageConfigEntity, type TenantStorageConfigRepository } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import type { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { PlatformStorageSettingsResolver } from '../platform-storage-settings.resolver';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function build(rows: unknown[] | Error) {
  const repo = {
    findAllTenantDefaults: vi.fn(async (tenantId: string) => {
      expect(tenantId).toBe(SYSTEM_TENANT_ID);
      if (rows instanceof Error) throw rows;
      return rows;
    }),
  } as unknown as TenantStorageConfigRepository;
  const appSettings = { getValueWithDefault: vi.fn((_k: string, d: unknown) => d) } as unknown as IAppSettingsService;
  return new PlatformStorageSettingsResolver(repo, appSettings);
}

const row = (over: Record<string, unknown> = {}) =>
  ({
    version: 4,
    provider: StorageProviderType.MINIO,
    endpoint: 'http://hope-minio:9000',
    publicEndpoint: 'https://admin.example.com',
    region: null,
    forcePathStyle: true,
    containerPrefix: '',
    credentialsRef: 'platform/storage/minio',
    ...over,
  }) as unknown as TenantStorageConfigEntity;

describe('PlatformStorageSettingsResolver.dedicatedRowValues (TASK-1033 T3)', () => {
  it('reports each field the SYSTEM row stores, with the row version', async () => {
    const values = await build([row()]).dedicatedRowValues();
    expect(values['storage.platformDefault.publicEndpoint']).toEqual({ value: 'https://admin.example.com', version: 4 });
    expect(values['storage.platformDefault.endpoint']).toEqual({ value: 'http://hope-minio:9000', version: 4 });
    expect(values['storage.platformDefault.forcePathStyle']).toEqual({ value: true, version: 4 });
    // Provider in the descriptor's wire vocabulary, as the effective read serves it.
    expect(values['storage.platformDefault.provider']).toEqual({ value: 'minio', version: 4 });
  });

  it('omits a field the row does not set (null / empty) — that key has no dedicated-row value', async () => {
    const values = await build([row()]).dedicatedRowValues();
    expect(values['storage.platformDefault.region']).toBeUndefined();
    expect(values['storage.platformDefault.containerPrefix']).toBeUndefined();
  });

  it('never exposes the credentials pointer', async () => {
    const values = await build([row()]).dedicatedRowValues();
    expect(Object.keys(values).some((k) => k.includes('credential'))).toBe(false);
  });

  it('returns nothing when no SYSTEM row exists', async () => {
    expect(await build([]).dedicatedRowValues()).toEqual({});
  });

  it('propagates a backend error rather than reporting "no row"', async () => {
    await expect(build(new Error('db down')).dedicatedRowValues()).rejects.toThrow('db down');
  });
});
