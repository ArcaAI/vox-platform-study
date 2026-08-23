/**
 * TENANT-SCOPE writes through the single enforcement point.
 *
 * Classification declared `maxScope` and the write path made it mean something:
 * six knobs are now `maxScope: 'tenant'`, so the write lane has to be able to
 * persist a row that belongs to a TENANT rather than to the platform. Previously
 * `write()` accepted `scope: 'tenant'` (the clamp allowed it) and then wrote
 * the platform row anyway — the clamp passed and the value landed in the wrong
 * place.
 *
 * The contract pinned here:
 *   1. a `system`-scope write is a PLATFORM change → super admins only (403),
 *      independent of `globalOnly`, which gates the KEY not the SCOPE;
 *   2. a `tenant`-scope write persists under the CALLER'S tenant, in the
 *      reserved `registry` namespace, so it lands in the tenant lane of the
 *      settings cache and nowhere else;
 *   3. a tenant-scope write with no working tenant (a super admin who has not
 *      selected one) is refused rather than silently becoming a platform write;
 *   4. the OCC + sys-event + cache-refresh path is unchanged.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SysEventType } from '@arcaai/domains';
import { SettingsRegistryWriteService, REGISTRY_SETTING_NAMESPACE } from '../settings-registry-write.service';

/** The SOLE platform-configuration tier (owner ruling 2026-08-20, TASK-763 OD-1). */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
/** GLOBAL — a CUSTOMER tenant (the platform-admin playground), never a config tier. */
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const CUSTOMER_TENANT = '11111111-1111-1111-1111-111111111111';

function makeService(opts: { roles?: string[]; tenantId?: string | undefined; existing?: any; platformValue?: unknown } = {}) {
  const appSettings = {
    getFromCache: vi.fn().mockReturnValue(undefined),
    getValueWithDefault: vi.fn((_k: string, d: unknown) => d),
    getTenantValueFromCache: vi.fn().mockReturnValue(null),
    // The PLATFORM row a tenant write is floored against (`platformFloorFor`).
    // Null = no stored SYSTEM row, so the descriptor default is the floor.
    getValueFromCache: vi.fn().mockReturnValue(opts.platformValue ?? null),
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
        ? { id: 'u1', roles: opts.roles ?? ['SUPER_ADMIN'] }
        : k === 'tenantId'
          ? 'tenantId' in opts
            ? opts.tenantId
            : CUSTOMER_TENANT
          : undefined,
    ),
    set: vi.fn(),
    // `write()` re-enters CLS on the TARGET tenant for the persistence step
    // (`SettingsRegistryWriteService.actingOnTenant`); pass through.
    run: vi.fn(async (fn: () => unknown) => fn()),
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

  it('still broadcasts the sys-event and refreshes the read cache', async () => {
    const { svc, emitter, appSettings } = makeService({ roles: [], tenantId: CUSTOMER_TENANT });

    await svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' });

    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
    expect(appSettings.refreshCache).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant-scope write for a key capped at system scope', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'], tenantId: CUSTOMER_TENANT });
    // `logLevel` is maxScope: 'system'.
    await expect(svc.write('logLevel', 'debug', { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('refuses a tenant-scope write with no working tenant rather than writing the platform row', async () => {
    const { svc, globalSettings } = makeService({ roles: ['SUPER_ADMIN'], tenantId: undefined });
    await expect(svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('refuses a tenant-scope write whose working tenant IS the platform (SYSTEM) tenant', async () => {
    const { svc, globalSettings } = makeService({ roles: ['SUPER_ADMIN'], tenantId: SYSTEM_TENANT_ID });
    await expect(svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('ALLOWS a tenant-scope write whose working tenant is GLOBAL — GLOBAL is an ordinary CUSTOMER tenant, not a platform tier', async () => {
    // Owner ruling 2026-08-20 (TASK-763 OD-1): the runtime cascade is request
    // tenant → SYSTEM, full stop. GLOBAL (`50000000-…`) is the platform-admin
    // playground tenant, and must be free to set its OWN tenant-scope rows
    // exactly like any other customer tenant — that is the whole point of the
    // playground (trial config, then promote the validated result into SYSTEM).
    const { svc, globalSettings } = makeService({ roles: [], tenantId: GLOBAL_TENANT_ID });

    const result = await svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' });

    expect(globalSettings.create).toHaveBeenCalledTimes(1);
    expect(globalSettings.create.mock.calls[0]![0]).toMatchObject({
      key: 'rateLimit.maxRequests',
      namespace: REGISTRY_SETTING_NAMESPACE,
      tenantId: GLOBAL_TENANT_ID,
    });
    expect(result.scope).toBe('tenant');
  });
});

describe('system-scope write is a platform change — super admins only', () => {
  it('rejects a SYSTEM-scope write from a tenant admin even for a tenant-editable key', async () => {
    const { svc, globalSettings } = makeService({ roles: [], tenantId: CUSTOMER_TENANT });
    // `rateLimit.maxRequests` is NOT globalOnly (a tenant may set its own row),
    // but the platform row is still a super-admin surface.
    await expect(svc.write('rateLimit.maxRequests', 10)).rejects.toBeInstanceOf(ForbiddenException);
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('allows a super admin to write the platform row, on the SYSTEM tenant (never GLOBAL)', async () => {
    const { svc, globalSettings } = makeService({ roles: ['SUPER_ADMIN'], tenantId: CUSTOMER_TENANT });

    const result = await svc.write('rateLimit.maxRequests', 250);

    expect(globalSettings.create.mock.calls[0]![0]).toMatchObject({ tenantId: SYSTEM_TENANT_ID });
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
    const { svc } = makeService({ roles: ['SUPER_ADMIN'], tenantId: undefined });
    await expect(svc.getBackingRowVersion('rateLimit.maxRequests', 'tenant')).resolves.toBe(0);
  });
});

/**
 * The tighten-only floor, enforced HERE — the wiring, not the policy.
 *
 * `guardrail.policy.*` declared this exact rule for 13 keys and shipped a
 * correct guard that NOTHING called: the policy existed, the enforcement point
 * did not. Now the direction is a descriptor field and this lane applies it
 * generically, so the assertions below are about the write lane actually
 * invoking it — the direction semantics have their own tests next door.
 */
describe('tighten-only floor — enforced in the write lane, descriptor-driven', () => {
  it('REJECTS a tenant write that would loosen a verdict-deciding key (403, no row written)', async () => {
    // `piiThreshold` is lower-is-stricter: 0.9 catches LESS PII than the
    // platform floor of 0.5, so it is a privilege violation, not a clamp.
    const { svc, globalSettings } = makeService({ roles: [], tenantId: CUSTOMER_TENANT, platformValue: 0.5 });

    await expect(svc.write('guardrail.policy.piiThreshold', 0.9, { scope: 'tenant' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(globalSettings.create).not.toHaveBeenCalled();
    expect(globalSettings.update).not.toHaveBeenCalled();
  });

  it('PERMITS a tenant write that tightens the same key, and writes it unclamped', async () => {
    const { svc, globalSettings } = makeService({ roles: [], tenantId: CUSTOMER_TENANT, platformValue: 0.5 });

    const result = await svc.write('guardrail.policy.piiThreshold', 0.3, { scope: 'tenant' });

    expect(result).toMatchObject({ value: 0.3, scope: 'tenant' });
    expect(globalSettings.create.mock.calls[0]![0]).toMatchObject({ value: '0.3', tenantId: CUSTOMER_TENANT });
  });

  it('REJECTS a taxonomy that drops a platform-mandated category', async () => {
    const floor = ['harassment', 'hate_speech', 'violence'];
    const { svc } = makeService({ roles: [], tenantId: CUSTOMER_TENANT, platformValue: floor });

    await expect(svc.write('guardrail.policy.harmfulLabels', ['harassment', 'violence'], { scope: 'tenant' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('does NOT floor a system-scope write — that write IS the platform value', async () => {
    const { svc, globalSettings } = makeService({ roles: ['SUPER_ADMIN'], tenantId: SYSTEM_TENANT_ID, platformValue: 0.5 });

    await expect(svc.write('guardrail.policy.piiThreshold', 0.9, { scope: 'system' })).resolves.toMatchObject({ value: 0.9 });
    expect(globalSettings.create).toHaveBeenCalledTimes(1);
  });

  it('leaves a key with no declared floor completely untouched', async () => {
    // No `floorDirection`, so the guard never runs — a tenant may set this
    // freely (subject to the READ-path clamp, which is a different mechanism).
    const { svc } = makeService({ roles: [], tenantId: CUSTOMER_TENANT, platformValue: 5 });
    await expect(svc.write('rateLimit.maxRequests', 999, { scope: 'tenant' })).resolves.toMatchObject({ value: 999 });
  });
});
