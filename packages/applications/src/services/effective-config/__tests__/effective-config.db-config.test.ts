// lane A.1 — the LOAD-BEARING test.
//
// Not "the resolver returns a value" (that is
// `platform-storage-settings.resolver.test.ts`) and not "the facade dispatches"
// (that is `effective-settings.db-config.test.ts`). This asserts the thing the
// three blocked lanes actually needed and could not get: a `db-config` key
// declared `consumedBy` ARRIVES ON THE PULL PAYLOAD WITH A REAL VALUE.
//
// It is wired end to end on purpose — real `EffectiveSettingsService`, real
// `PlatformStorageSettingsResolver`, real registry, only the repository and the
// GlobalSetting snapshot stubbed. A stub in the middle would have passed
// happily against the broken code, which is exactly why the defect survived
// three reviews.

import { StorageProviderType, type TenantStorageConfigEntity, type TenantStorageConfigRepository } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import type { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import type { ConfigResolver } from '../../config-resolver/config-resolver.service';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { PlatformStorageSettingsResolver } from '../../tenant-storage-config/platform-storage-settings.resolver';
import { EffectiveConfigService } from '../effective-config.service';

function systemRow(over: Record<string, unknown> = {}): TenantStorageConfigEntity {
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

function pullService(rows: TenantStorageConfigEntity[]): EffectiveConfigService {
  const repo = {
    findAllTenantDefaults: vi.fn(async () => rows),
  } as unknown as TenantStorageConfigRepository;
  const appSettings = {
    getValueWithDefault: vi.fn((_key: string, fallback: unknown) => fallback),
  } as unknown as IAppSettingsService;

  const settings = new EffectiveSettingsService(
    {} as unknown as ConfigResolver,
    undefined,
    undefined,
    new PlatformStorageSettingsResolver(repo, appSettings),
  );
  return new EffectiveConfigService(settings);
}

describe('the pull payload carries db-config keys (A.1)', () => {
  it('serves storage.platformDefault.* to harness with real values and a db source', async () => {
    const payload = await pullService([systemRow()]).resolveForService('harness');

    expect(payload.settings['storage.platformDefault.endpoint']).toEqual({
      value: 'http://minio.internal:9000',
      dataType: 'string',
      source: 'db',
    });
    expect(payload.settings['storage.platformDefault.region']).toEqual({ value: 'ap-south-1', dataType: 'string', source: 'db' });
    expect(payload.settings['storage.platformDefault.containerPrefix']).toEqual({ value: 'hope-', dataType: 'string', source: 'db' });
    // The provider enum is deliberately NOT served to harness — the claim-check
    // backend is selected on a different axis. See the descriptor's comment.
    expect(payload.settings['storage.platformDefault.provider']).toBeUndefined();
  });

  it('serves the provider selection to stt', async () => {
    const payload = await pullService([systemRow({ provider: StorageProviderType.AZURE_BLOB })]).resolveForService('stt');
    expect(payload.settings['storage.platformDefault.provider']).toEqual({ value: 'azure_blob', dataType: 'enum', source: 'db' });
  });

  it('NEVER puts the credentials pointer on the wire', async () => {
    const payload = await pullService([systemRow()]).resolveForService('harness');
    expect(payload.settings['storage.platformDefault.credentials']).toBeUndefined();
  });

  it('labels the env bootstrap tier as env-fallback, not as a database answer', async () => {
    // No SYSTEM row and no GlobalSetting: the value is the descriptor default.
    // Reporting `source: 'db'` here would tell an operator the platform row is
    // configured when it is not.
    const payload = await pullService([]).resolveForService('stt');
    expect(payload.settings['storage.platformDefault.provider']).toEqual({ value: 'minio', dataType: 'enum', source: 'env-fallback' });
  });
});
