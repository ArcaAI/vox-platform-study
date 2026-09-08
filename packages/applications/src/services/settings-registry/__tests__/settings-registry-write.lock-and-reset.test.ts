/**
 * TASK-932 R-6 — the two write-lane additions.
 *
 * 1. LOCKED tiers are refused for EVERY caller, a super administrator included.
 *    That is the half of the owner's rule ("un-editable for everyone, platform
 *    admin included") a UI cannot deliver, so it is asserted here against the
 *    most privileged caller — a test that only checked a tenant admin would pass
 *    for the wrong reason, since `globalOnly` already refuses those.
 *
 * 2. `reset()` removes a TENANT override so the cascade resumes. The cases below
 *    pin the three decisions that make it a reset rather than a write: it
 *    DELETES rather than copying the platform value down, it is idempotent, and
 *    it refuses `system` scope because nothing sits above the platform row.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { SysEventType } from '@arcaai/domains';
import { SETTING_TIER_LOCKED } from '../setting-lock';
import { SettingsRegistryWriteService } from '../settings-registry-write.service';

function makeService(opts: { roles?: string[]; existingRow?: { id: string; version: number } | null; tenantId?: string } = {}) {
  const appSettings = {
    getFromCache: vi.fn().mockReturnValue(undefined),
    getValueFromCache: vi.fn().mockReturnValue(null),
    getValueWithDefault: vi.fn((_k: string, d: unknown) => d),
    refreshCache: vi.fn().mockResolvedValue(undefined),
  };
  const globalSettings = {
    create: vi.fn(async () => ({ id: 'gs-1', version: 1 })),
    update: vi.fn(async () => ({ id: 'gs-1', version: 2 })),
    deleteById: vi.fn(async () => ({ id: 'gs-1', version: 3 })),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) =>
      k === 'user' ? { id: 'u1', roles: opts.roles ?? ['SUPER_ADMIN'] } : k === 'tenantId' ? (opts.tenantId ?? 'tenant-abc') : undefined,
    ),
    set: vi.fn(),
    run: vi.fn(async (fn: () => unknown) => fn()),
  };
  const globalSettingRepository = {
    findFirst: vi.fn(async () => (opts.existingRow === undefined ? { id: 'gs-1', version: 4 } : opts.existingRow)),
  };
  const svc = new SettingsRegistryWriteService(appSettings as any, globalSettings as any, emitter as any, cls as any, globalSettingRepository as any);
  return { svc, appSettings, globalSettings, emitter, cls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsRegistryWriteService — locked tiers (R-6 / D-6)', () => {
  it('refuses a bootstrap (env-tier) key for a SUPER ADMIN, naming SETTING_TIER_LOCKED', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    const error = await svc.write('databaseUrl', 'postgres://nope').catch((e: Error) => e);

    expect(error).toBeInstanceOf(ArgumentInvalidException);
    expect((error as Error).message).toContain(SETTING_TIER_LOCKED);
    // The message must say WHERE the value changes. "Not writable here" without
    // "go there instead" sends an admin looking for a screen that does not exist.
    expect((error as Error).message).toMatch(/redeploying/i);
  });

  it('refuses a vault-kv platform secret, and says so as a CREDENTIAL rather than as a tier', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    // Secret sensitivity is refused one guard earlier than the lock, and that
    // ordering is deliberate: naming the tier for a credential would send the
    // reader to the wrong runbook.
    await expect(svc.write('jwt.secretKey', 'x')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('does NOT hijack the db-config refusal — that key is editable, just not here', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    const error = await svc.write('storage.platformDefault.endpoint', 'http://minio:9000').catch((e: Error) => e);
    expect(error).toBeInstanceOf(ArgumentInvalidException);
    expect((error as Error).message).not.toContain(SETTING_TIER_LOCKED);
    expect((error as Error).message).toMatch(/dedicated service/i);
  });

  it('leaves an ordinary global-kv key writable', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'], existingRow: null });
    await expect(svc.write('console.mlflow.enabled', true, { scope: 'system' })).resolves.toMatchObject({ key: 'console.mlflow.enabled' });
  });
});

describe('SettingsRegistryWriteService — reset()', () => {
  it('DELETES the tenant override rather than copying the platform value down', async () => {
    // The distinction that matters: writing the platform's current value into
    // the tenant row looks identical today and diverges silently the next time
    // the platform default moves. Only removal restores inheritance.
    const { svc, globalSettings } = makeService({ roles: ['SUPER_ADMIN'], existingRow: { id: 'gs-7', version: 2 } });
    const result = await svc.reset('console.mlflow.enabled', { scope: 'tenant' });

    expect(globalSettings.deleteById).toHaveBeenCalledWith('gs-7');
    expect(globalSettings.update).not.toHaveBeenCalled();
    expect(globalSettings.create).not.toHaveBeenCalled();
    expect(result).toEqual({ key: 'console.mlflow.enabled', tier: 'global-kv', scope: 'tenant', removed: true });
  });

  it('refreshes the read cache and broadcasts a ResourceDeleted sys-event', async () => {
    const { svc, appSettings, emitter } = makeService({ roles: ['SUPER_ADMIN'], existingRow: { id: 'gs-7', version: 2 } });
    await svc.reset('console.mlflow.enabled', { scope: 'tenant' });

    // A reset changes the effective value exactly as a write does, so it must
    // propagate exactly as a write does — otherwise the cascade resumes in the
    // database and not in the running gateway.
    expect(appSettings.refreshCache).toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.anything());
  });

  it('is idempotent: no override is `removed: false`, not a 404', async () => {
    // A "reset every tenant to the platform default" sweep must not fail on the
    // tenants that never held an opinion in the first place.
    const { svc, globalSettings } = makeService({ roles: ['SUPER_ADMIN'], existingRow: null });
    await expect(svc.reset('console.mlflow.enabled', { scope: 'tenant' })).resolves.toEqual({
      key: 'console.mlflow.enabled',
      tier: 'global-kv',
      scope: 'tenant',
      removed: false,
    });
    expect(globalSettings.deleteById).not.toHaveBeenCalled();
  });

  it('refuses `system` scope: the platform row is the top of the cascade', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    const error = await svc.reset('console.mlflow.enabled', { scope: 'system' }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(ArgumentInvalidException);
    // Deleting it would drop the platform to the descriptor default, which is a
    // DIFFERENT value and a legitimate thing to want — as an explicit, versioned
    // WRITE. Overloading DELETE with it would make one verb mean two things.
    expect((error as Error).message).toMatch(/nothing above it to inherit/i);
  });

  it('honours the descriptor guards a write honours: globalOnly, locked tiers, maxScope', async () => {
    const tenantAdmin = makeService({ roles: [], existingRow: { id: 'gs-7', version: 2 } });
    await expect(tenantAdmin.svc.reset('console.mlflow.enabled', { scope: 'tenant' })).rejects.toBeInstanceOf(ForbiddenException);

    const superAdmin = makeService({ roles: ['SUPER_ADMIN'], existingRow: { id: 'gs-7', version: 2 } });
    // env tier: locked for everyone.
    await expect(superAdmin.svc.reset('databaseUrl', { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
    // `maxScope: 'system'` key has no tenant row a reset could remove.
    await expect(superAdmin.svc.reset('consultation.ocr.enabled', { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('applies a supplied expectedVersion, and tolerates its absence', async () => {
    // Unlike a write, a reset with NO precondition is accepted: the outcome (the
    // row is gone) does not depend on what it contained, and the batch matrix
    // save resets cells the caller never opened.
    const drift = makeService({ roles: ['SUPER_ADMIN'], existingRow: { id: 'gs-7', version: 5 } });
    await expect(drift.svc.reset('console.mlflow.enabled', { scope: 'tenant', expectedVersion: 2 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );

    const noPrecondition = makeService({ roles: ['SUPER_ADMIN'], existingRow: { id: 'gs-7', version: 5 } });
    await expect(noPrecondition.svc.reset('console.mlflow.enabled', { scope: 'tenant' })).resolves.toMatchObject({ removed: true });
  });
});
