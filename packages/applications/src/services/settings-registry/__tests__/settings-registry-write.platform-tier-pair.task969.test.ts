/**
 * TASK-969 WS-1 step 2 — the write lane refuses the DEAD scope.
 *
 * A SYSTEM-scope write to a key that declares `platformTierKey` used to be
 * accepted, persisted, versioned and read back — while its only consumer
 * (`TextRequestEnrichmentService.applyTenantGuardrailPolicy`) skipped it,
 * because the push is emitted only when the cascade reports
 * `sourceScope === 'tenant'`. Every layer reported something true and the
 * runtime kept the old value.
 *
 * The refusal is the BACKSTOP for the console fix: the API is reachable without
 * the console, so hiding the option in a picker is not the same as making the
 * write impossible. Its message names the twin, because "refused" without
 * "write THAT key instead" leaves an admin with no next step — the same shape
 * the DELETE-at-system refusal already uses.
 *
 * It is DESCRIPTOR-DRIVEN: no key list in this file, so declaring
 * `platformTierKey` is the only thing needed to govern a new pair.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SettingsRegistryWriteService, REGISTRY_SETTING_NAMESPACE } from '../settings-registry-write.service';

const CUSTOMER_TENANT = '11111111-1111-1111-1111-111111111111';

/** The TENANT half — declares `platformTierKey`; a SYSTEM row for it has no reader. */
const TENANT_HALF = 'text.guardrailPolicy.requireMedical';
/** Its PLATFORM twin — `maxScope: 'system'`, on the pull route. THIS is the platform row. */
const PLATFORM_TWIN = 'text.externalGuardrail.requireMedical';

function makeService(opts: { roles?: string[]; tenantId?: string | undefined } = {}) {
  const appSettings = {
    getFromCache: vi.fn().mockReturnValue(undefined),
    getValueWithDefault: vi.fn((_k: string, d: unknown) => d),
    getTenantValueFromCache: vi.fn().mockReturnValue(null),
    getValueFromCache: vi.fn().mockReturnValue(null),
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
    run: vi.fn(async (fn: () => unknown) => fn()),
  };
  const globalSettingRepository = { findFirst: vi.fn(async () => null) };
  const svc = new SettingsRegistryWriteService(appSettings as any, globalSettings as any, emitter as any, cls as any, globalSettingRepository as any);
  return { svc, globalSettings };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('a system-scope write on a paired key is refused', () => {
  it('throws ArgumentInvalidException (→ 400) and names the twin to write instead', async () => {
    const { svc, globalSettings } = makeService();

    await expect(svc.write(TENANT_HALF, false, { scope: 'system' })).rejects.toBeInstanceOf(ArgumentInvalidException);
    await expect(svc.write(TENANT_HALF, false, { scope: 'system' })).rejects.toThrow(new RegExp(PLATFORM_TWIN.replace(/\./g, '\\.')));
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('refuses the DEFAULT scope too — `write()` defaults to system, which is the trap', async () => {
    const { svc, globalSettings } = makeService();

    await expect(svc.write(TENANT_HALF, false)).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('still refuses NON-super-admins first — the privilege boundary is not weakened into a 400', async () => {
    const { svc } = makeService({ roles: [] });

    // `globalOnly` → 403 runs BEFORE the pairing refusal, so a tenant admin is
    // told it is not theirs to write rather than shown the platform key name.
    await expect(svc.write(TENANT_HALF, false, { scope: 'system' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('everything else about the pair is unchanged', () => {
  it('the TENANT-scope write — the one with a reader — still persists under the caller tenant', async () => {
    const { svc, globalSettings } = makeService({ tenantId: CUSTOMER_TENANT });

    const result = await svc.write(TENANT_HALF, false, { scope: 'tenant' });

    expect(globalSettings.create).toHaveBeenCalledTimes(1);
    expect(globalSettings.create.mock.calls[0]![0]).toMatchObject({
      key: TENANT_HALF,
      value: 'false',
      namespace: REGISTRY_SETTING_NAMESPACE,
      tenantId: CUSTOMER_TENANT,
    });
    expect(result).toMatchObject({ key: TENANT_HALF, value: false, scope: 'tenant' });
  });

  it('the PLATFORM twin is still writable at system scope — that is where the platform row belongs', async () => {
    const { svc, globalSettings } = makeService();

    const result = await svc.write(PLATFORM_TWIN, false, { scope: 'system' });

    expect(result).toMatchObject({ key: PLATFORM_TWIN, value: false, scope: 'system' });
    expect(globalSettings.create).toHaveBeenCalledTimes(1);
  });
});
