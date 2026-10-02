/**
 * TASK-1033 T5 — `PUT admin/tenant-storage-configs/platform` resets a non-secret field to its
 * default when the field is sent as `null`, so the console can offer "reset to default" per field.
 * `credentialsRef` (a Vault path) is untouched by this ticket; a tenant admin is still 403.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { StorageProviderType, StorageTopologyType, SYSTEM_TENANT_ID, TenantStorageConfigFactory } from '@arcaai/domains';

import { TenantStorageConfigService } from '../tenant-storage-config.service';
import { UpsertPlatformStorageConfigRequest } from '../dto';
import { PLATFORM_STORAGE_CREDENTIALS_REF } from '../platform-storage-config';

const USER = 'user-1';

function fullSystemRow() {
  return TenantStorageConfigFactory.CreateConfig({
    tenantId: SYSTEM_TENANT_ID,
    bucketId: null,
    provider: StorageProviderType.MINIO,
    topology: StorageTopologyType.SHARED,
    endpoint: 'http://hope-minio:9000',
    publicEndpoint: 'https://admin.example.com',
    region: 'us-east-1',
    forcePathStyle: true,
    containerPrefix: 'hope-',
    credentialsRef: PLATFORM_STORAGE_CREDENTIALS_REF,
  });
}

function build(row: unknown, user: Record<string, unknown>) {
  const configRepo = {
    findSystemDefault: vi.fn().mockResolvedValue(row),
    create: vi.fn(async (e) => e),
    updateWithVersion: vi.fn(async (_id, e) => e),
  };
  const factory = { invalidate: vi.fn(), invalidatePlatform: vi.fn() };
  const cls = { get: vi.fn((k: string) => (({ tenantId: '', user }) as Record<string, unknown>)[k]) };
  const service = new TenantStorageConfigService(configRepo as any, {} as any, factory as any, { emit: vi.fn() } as any, cls as any);
  return { service, configRepo };
}

const NULLABLE_FIELDS = ['endpoint', 'publicEndpoint', 'region', 'forcePathStyle', 'containerPrefix'] as const;

describe('TASK-1033 T5 — platform storage default: null resets a field', () => {
  it.each(NULLABLE_FIELDS)('the request DTO accepts null for %s', (field) => {
    const dto = plainToInstance(UpsertPlatformStorageConfigRequest, { provider: 'MINIO', expectedVersion: 1, [field]: null });
    expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).toEqual([]);
  });

  it.each(NULLABLE_FIELDS)('null %s clears that field only; credentialsRef is unchanged', async (field) => {
    const row = fullSystemRow();
    const before = { ...Object.fromEntries(NULLABLE_FIELDS.map((f) => [f, (row as any)[f]])) };
    const { service, configRepo } = build(row, { id: USER, roles: ['SUPER_ADMIN'] });

    const res = await service.upsertPlatformDefault({ provider: row.provider, [field]: null, expectedVersion: row.version } as never);

    const written = configRepo.updateWithVersion.mock.calls[0]![1];
    expect(written[field]).toBeNull();
    expect((res as any)[field]).toBeNull();
    for (const other of NULLABLE_FIELDS.filter((f) => f !== field)) expect(written[other]).toEqual(before[other]);
    expect(written.credentialsRef).toBe(PLATFORM_STORAGE_CREDENTIALS_REF);
  });

  it('a tenant admin is still 403 and nothing is written', async () => {
    const row = fullSystemRow();
    const { service, configRepo } = build(row, { id: USER, roles: ['TENANT_ADMIN'] });
    await expect(service.upsertPlatformDefault({ provider: row.provider, endpoint: null, expectedVersion: row.version })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(configRepo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('provider stays required — null provider is refused by the DTO (the row would be invalid)', () => {
    const dto = plainToInstance(UpsertPlatformStorageConfigRequest, { provider: null, expectedVersion: 1 });
    expect(validateSync(dto).length).toBeGreaterThan(0);
  });
});
