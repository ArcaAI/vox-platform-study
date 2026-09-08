/**
 * TASK-932 R-1 / R-6 — the registry lane's controller-level rules.
 *
 * Two things live here that the service cannot express:
 *
 *  - the 404 that makes the lane un-walkable as a directory of platform
 *    configuration. The service's `globalOnly` guard is a 403, which is right
 *    for a key the caller CAN see; it is wrong for one whose existence the
 *    caller should not learn.
 *  - which ROW a read is about. `scope=system` addresses the platform row on the
 *    reserved SYSTEM tenant, so it needs no working tenant — and demanding one
 *    is what made a platform admin unable to open, and therefore to save, any
 *    setting from an unscoped session.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsService, SettingsRegistryWriteService } from '@arcaai/applications';
import { SettingsRegistryWriteController } from '../settings-registry-write.controller';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** A key a tenant admin may address: `global-kv`, not `globalOnly`, tenant-deep. */
const TENANT_KEY = 'rateLimit.maxRequests';
/** `globalOnly` with a tenant-deep maxScope — the platform decides it. */
const PLATFORM_KEY = 'console.mlflow.enabled';
/** `maxScope: 'system'` — no tenant row could ever exist for it. */
const SYSTEM_ONLY_KEY = 'consultation.ocr.enabled';

function controllerFor(
  user: unknown,
  overrides: { effective?: Partial<EffectiveSettingsService>; write?: Partial<SettingsRegistryWriteService>; clsTenantId?: string } = {},
) {
  const cls = {
    get: (key: string) => (key === 'user' ? user : key === 'tenantId' ? overrides.clsTenantId : undefined),
  } as never;
  const effective = {
    resolveEffective: vi.fn(async (key: string) => ({ key, tier: 'global-kv', value: 1, sourceScope: 'system' })),
    ...overrides.effective,
  } as unknown as EffectiveSettingsService;
  const write = {
    getBackingRowVersion: vi.fn(async () => 0),
    write: vi.fn(async (key: string) => ({ key, tier: 'global-kv', value: 1, scope: 'system', version: 1 })),
    reset: vi.fn(async (key: string) => ({ key, tier: 'global-kv', scope: 'tenant', removed: true })),
    ...overrides.write,
  } as unknown as SettingsRegistryWriteService;
  return { controller: new SettingsRegistryWriteController(cls, effective, write), effective, write };
}

const superAdmin = { roles: ['SUPER_ADMIN'] };
const tenantAdmin = { roles: ['TENANT_ADMIN'], tenantId: 'tnt-self' };

describe('SettingsRegistryWriteController — tenant visibility (R-1 / D-5)', () => {
  it('404s a platform-only key on GET, PUT and DELETE for a tenant admin', async () => {
    const { controller, effective, write } = controllerFor(tenantAdmin, { clsTenantId: 'tnt-self' });

    for (const key of [PLATFORM_KEY, SYSTEM_ONLY_KEY]) {
      await expect(controller.getSetting(key)).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.putSetting(key, { value: true } as never, undefined)).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.resetSetting(key)).rejects.toBeInstanceOf(NotFoundException);
    }
    // The refusal happens BEFORE any resolution or write — nothing downstream
    // observes a request for a key the caller may not address.
    expect(effective.resolveEffective).not.toHaveBeenCalled();
    expect(write.write).not.toHaveBeenCalled();
    expect(write.reset).not.toHaveBeenCalled();
  });

  it('gives an unknown key and a hidden key the same 404, so neither confirms the other', async () => {
    const { controller } = controllerFor(tenantAdmin, { clsTenantId: 'tnt-self' });
    await expect(controller.getSetting('no.such.key')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.getSetting(PLATFORM_KEY)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets a tenant admin through for a key its own tenant can hold an opinion on', async () => {
    const { controller, effective } = controllerFor(tenantAdmin, { clsTenantId: 'tnt-self' });
    await expect(controller.getSetting(TENANT_KEY, undefined, undefined, undefined, 'tenant')).resolves.toBeTruthy();
    expect(effective.resolveEffective).toHaveBeenCalledWith(TENANT_KEY, { tenantId: 'tnt-self', departmentId: null, doctorId: null });
  });

  it('a super admin still reaches every key', async () => {
    const { controller } = controllerFor(superAdmin);
    await expect(controller.getSetting(PLATFORM_KEY, undefined, undefined, undefined, 'system')).resolves.toBeTruthy();
    await expect(controller.getSetting(SYSTEM_ONLY_KEY, undefined, undefined, undefined, 'system')).resolves.toBeTruthy();
  });
});

describe('SettingsRegistryWriteController — which row a read is about (R-6)', () => {
  it('resolves SYSTEM at scope=system with NO working tenant and NO ?tenantId', async () => {
    // The reported defect: this used to be a 400 ("Platform admins must pass
    // ?tenantId="), so the drawer could not load and therefore nothing could be
    // saved from an unscoped platform-admin session.
    const { controller, effective, write } = controllerFor(superAdmin);
    await controller.getSetting(TENANT_KEY, undefined, undefined, undefined, 'system');

    expect(effective.resolveEffective).toHaveBeenCalledWith(TENANT_KEY, { tenantId: SYSTEM_TENANT_ID, departmentId: null, doctorId: null });
    // The ETag row follows the same scope, or a tenant write would be
    // preconditioned on the platform row's version and 412 forever.
    expect(write.getBackingRowVersion).toHaveBeenCalledWith(TENANT_KEY, 'system');
  });

  it('defaults to the platform row when no scope is given — the console asks for it that way', async () => {
    const { controller, effective } = controllerFor(superAdmin);
    await controller.getSetting(TENANT_KEY);
    expect(effective.resolveEffective).toHaveBeenCalledWith(TENANT_KEY, expect.objectContaining({ tenantId: SYSTEM_TENANT_ID }));
  });

  it('does NOT let a selected working tenant silently redirect a system-scope read', async () => {
    // The read and the write must agree about which row they are talking about:
    // the write lane targets SYSTEM for `scope=system` whatever tenant is
    // selected, so a read that followed the working tenant would show one row
    // and save another.
    const { controller, effective } = controllerFor(superAdmin, { clsTenantId: 'tnt-working' });
    await controller.getSetting(TENANT_KEY, undefined, undefined, undefined, 'system');
    expect(effective.resolveEffective).toHaveBeenCalledWith(TENANT_KEY, expect.objectContaining({ tenantId: SYSTEM_TENANT_ID }));
  });

  it('uses the working tenant at scope=tenant, and refuses when there is none', async () => {
    const scoped = controllerFor(superAdmin, { clsTenantId: 'tnt-working' });
    await scoped.controller.getSetting(TENANT_KEY, undefined, undefined, undefined, 'tenant');
    expect(scoped.effective.resolveEffective).toHaveBeenCalledWith(TENANT_KEY, expect.objectContaining({ tenantId: 'tnt-working' }));

    const unscoped = controllerFor(superAdmin);
    await expect(unscoped.controller.getSetting(TENANT_KEY, undefined, undefined, undefined, 'tenant')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an explicit ?tenantId still wins for an elevated caller at tenant scope', async () => {
    const { controller, effective } = controllerFor(superAdmin, { clsTenantId: 'tnt-working' });
    await controller.getSetting(TENANT_KEY, 'tnt-other', undefined, undefined, 'tenant');
    expect(effective.resolveEffective).toHaveBeenCalledWith(TENANT_KEY, expect.objectContaining({ tenantId: 'tnt-other' }));
  });
});

describe('SettingsRegistryWriteController — reset route', () => {
  it('defaults to tenant scope and delegates to the write lane', async () => {
    const { controller, write } = controllerFor(superAdmin, { clsTenantId: 'tnt-working' });
    await expect(controller.resetSetting(TENANT_KEY)).resolves.toMatchObject({ removed: true });
    expect(write.reset).toHaveBeenCalledWith(TENANT_KEY, { scope: 'tenant' });
  });

  it('passes `system` through so the SERVICE refuses it — one rule, one place', async () => {
    // The controller must not grow a second copy of the "nothing above the
    // platform row" rule; the lane owns it and answers the same 400 whether the
    // caller arrives by HTTP or from the matrix batch.
    const { controller, write } = controllerFor(superAdmin, { clsTenantId: 'tnt-working' });
    await controller.resetSetting(TENANT_KEY, 'system');
    expect(write.reset).toHaveBeenCalledWith(TENANT_KEY, { scope: 'system' });
  });
});
