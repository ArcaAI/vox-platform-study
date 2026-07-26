/**
 * TASK-558 lane I — TENANT-SCOPE writes through the single enforcement point.
 *
 * Lane F declared `maxScope` and lane I made it mean something: six knobs are
 * now `maxScope: 'tenant'`, so the write lane has to be able to persist a row
 * that belongs to a TENANT rather than to the platform. Before this lane
 * `write()` accepted `scope: 'tenant'` (the clamp allowed it) and then wrote
 * the platform row anyway — the clamp passed and the value landed in the wrong
 * place.
 *
 * The contract pinned here:
 *   1. a `system`-scope write is a PLATFORM change → global admins only (403),
 *      independent of `globalOnly`, which gates the KEY not the SCOPE;
 *   2. a `tenant`-scope write persists under the CALLER'S tenant, in the
 *      reserved `registry` namespace, so it lands in the tenant lane of the
 *      settings cache and nowhere else;
 *   3. a tenant-scope write with no working tenant (a global admin who has not
 *      selected one) is refused rather than silently becoming a platform write;
 *   4. the OCC + sys-event + cache-refresh path (§9.3 M8) is unchanged.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SysEventType } from '@arcaai/domains';
import { SettingsRegistryWriteService, REGISTRY_SETTING_NAMESPACE } from '../settings-registry-write.service';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const CUSTOMER_TENANT = '11111111-1111-1111-1111-111111111111';

function makeService(opts: { roles?: string[]; tenantId?: string | undefined; existing?: any } = {}) {
  const appSettings = {
    getFromCache: vi.fn().mockReturnValue(undefined),
    getValueWithDefault: vi.fn((_k: string, d: unknown) => d),
    getTenantValueFromCache: vi.fn().mockReturnValue(null),
    refreshCache: vi.fn().mockResolvedValue(undefined),
  };
  const globalSettings = {
    create: vi.fn(async () => ({ id: 'gs-1', version: 1 })),
    update: vi.fn(async () => ({ id: 'gs-1', version: 2 })),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) =>
      k === 'user'
        ? { id: 'u1', roles: opts.roles ?? ['GLOBAL_ADMIN'] }
        : k === 'tenantId'
          ? 'tenantId' in opts
            ? opts.tenantId
            : CUSTOMER_TENANT
          : undefined,
    ),
  };
  const globalSettingRepository = { findFirst: vi.fn(async () => opts.existing ?? null) };
  const svc = new SettingsRegistryWriteService(appSettings as any, globalSettings as any, emitter as any, cls as any, globalSettingRepository as any);
  return { svc, appSettings, globalSettings, emitter, globalSettingRepository };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('tenant-scope write persists under the caller tenant', () => {
  it('creates the backing row on the CALLER tenant, not the platform tenant', async () => {
    const { svc, globalSettings } = makeService({ roles: [], tenantId: CUSTOMER_TENANT });

    const result = await svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' });

    expect(globalSettings.create).toHaveBeenCalledTimes(1);
    expect(globalSettings.create.mock.calls[0]![0]).toMatchObject({
      key: 'rateLimit.maxRequests',
      value: '10',
      namespace: REGISTRY_SETTING_NAMESPACE,
      tenantId: CUSTOMER_TENANT,
    });
    expect(result).toMatchObject({ key: 'rateLimit.maxRequests', value: 10, scope: 'tenant', version: 1 });
  });

  it('looks the existing row up WITHIN the caller tenant (never the platform row)', async () => {
    const { svc, globalSettingRepository } = makeService({
      roles: [],
      tenantId: CUSTOMER_TENANT,
      existing: { id: 'gs-9', version: 4 },
    });

    await svc.write('rateLimit.maxRequests', 10, { scope: 'tenant', expectedVersion: 4 });

    expect(globalSettingRepository.findFirst.mock.calls[0]![0]).toMatchObject({
      where: { key: 'rateLimit.maxRequests', namespace: REGISTRY_SETTING_NAMESPACE, tenantId: CUSTOMER_TENANT },
    });
  });

  it('still broadcasts the sys-event and refreshes the read cache (§9.3 M8)', async () => {
    const { svc, emitter, appSettings } = makeService({ roles: [], tenantId: CUSTOMER_TENANT });

    await svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' });

    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
    expect(appSettings.refreshCache).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant-scope write for a key capped at system scope', async () => {
    const { svc } = makeService({ roles: ['GLOBAL_ADMIN'], tenantId: CUSTOMER_TENANT });
    // `logLevel` is maxScope: 'system'.
    await expect(svc.write('logLevel', 'debug', { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('refuses a tenant-scope write with no working tenant rather than writing the platform row', async () => {
    const { svc, globalSettings } = makeService({ roles: ['GLOBAL_ADMIN'], tenantId: undefined });
    await expect(svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('refuses a tenant-scope write whose working tenant IS a platform tenant', async () => {
    const { svc, globalSettings } = makeService({ roles: ['GLOBAL_ADMIN'], tenantId: GLOBAL_TENANT_ID });
    await expect(svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(globalSettings.create).not.toHaveBeenCalled();
  });
});

describe('system-scope write is a platform change — global admins only', () => {
  it('rejects a SYSTEM-scope write from a tenant admin even for a tenant-editable key', async () => {
    const { svc, globalSettings } = makeService({ roles: [], tenantId: CUSTOMER_TENANT });
    // `rateLimit.maxRequests` is NOT globalOnly (a tenant may set its own row),
    // but the platform row is still a global-admin surface.
    await expect(svc.write('rateLimit.maxRequests', 10)).rejects.toBeInstanceOf(ForbiddenException);
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('allows a global admin to write the platform row, on the platform tenant', async () => {
    const { svc, globalSettings } = makeService({ roles: ['GLOBAL_ADMIN'], tenantId: CUSTOMER_TENANT });

    const result = await svc.write('rateLimit.maxRequests', 250);

    expect(globalSettings.create.mock.calls[0]![0]).toMatchObject({ tenantId: GLOBAL_TENANT_ID });
    expect(result.scope).toBe('system');
  });
});

describe('reading the backing-row version is NOT a write', () => {
  it('does not 403 a tenant admin asking for a version (the GET route calls this)', async () => {
    const { svc } = makeService({ roles: [], tenantId: CUSTOMER_TENANT, existing: { id: 'gs-1', version: 3 } });
    // `SettingsRegistryWriteController.getSetting` calls this to render the
    // ETag the client echoes as `If-Match`. Folding the WRITE privilege into it
    // would turn every tenant admin's READ of a tenant-editable key into a 403.
    await expect(svc.getBackingRowVersion('rateLimit.maxRequests')).resolves.toBe(3);
  });

  it('reports the TENANT row version when asked for the tenant scope', async () => {
    const { svc, globalSettingRepository } = makeService({
      roles: [],
      tenantId: CUSTOMER_TENANT,
      existing: { id: 'gs-1', version: 3 },
    });
    await svc.getBackingRowVersion('rateLimit.maxRequests', 'tenant');
    expect(globalSettingRepository.findFirst.mock.calls[0]![0]).toMatchObject({
      where: { tenantId: CUSTOMER_TENANT },
    });
  });

  it('reports 0 rather than throwing when a tenant-scope read has no working tenant', async () => {
    const { svc } = makeService({ roles: ['GLOBAL_ADMIN'], tenantId: undefined });
    await expect(svc.getBackingRowVersion('rateLimit.maxRequests', 'tenant')).resolves.toBe(0);
  });
});
