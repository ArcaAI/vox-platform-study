/**
 * SettingsRegistryWriteService — unit tests.
 *
 * This is the SINGLE enforcement point for registry-key writes. The
 * point of these tests is that enforcement is DESCRIPTOR-DRIVEN — the service
 * must contain no hand-rolled per-key allow-list. Each guard is therefore
 * asserted against a key whose descriptor metadata carries the relevant flag,
 * and `assertWithinMaxScope` is asserted via a SPY so we prove the registry
 * method really is the enforcement point (its first production caller — it had
 * zero before).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SysEventType, ValueType } from '@arcaai/domains';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistryWriteService } from '../settings-registry-write.service';

function makeService(opts: { roles?: string[]; cached?: any } = {}) {
  const appSettings = {
    getFromCache: vi.fn().mockReturnValue(opts.cached ?? undefined),
    getValueWithDefault: vi.fn((_k: string, d: unknown) => d),
    refreshCache: vi.fn().mockResolvedValue(undefined),
  };
  const globalSettings = {
    create: vi.fn(async () => ({ id: 'gs-1', version: 1 })),
    update: vi.fn(async () => ({ id: 'gs-1', version: 2 })),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? ['SUPER_ADMIN'] } : k === 'tenantId' ? 'tenant-abc' : undefined)),
  };
  // The CAS version now comes from a FRESH repository read, not
  // from the (45s-stale) AppSettings snapshot. `opts.cached` therefore drives
  // this repository stub; `getFromCache` is no longer consulted for the write.
  const globalSettingRepository = {
    findFirst: vi.fn(async () => opts.cached ?? null),
  };
  const svc = new SettingsRegistryWriteService(appSettings as any, globalSettings as any, emitter as any, cls as any, globalSettingRepository as any);
  return { svc, appSettings, globalSettings, emitter, globalSettingRepository };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 9. globalOnly derived from descriptor metadata
// ===========================================================================

describe('SettingsRegistryWriteService — globalOnly enforcement', () => {
  it('rejects a globalOnly key for a tenant admin with 403', async () => {
    const { svc } = makeService({ roles: [] });
    // `agentic.context.liveDelta.maxChars` carries globalOnly: true.
    await expect(svc.write('agentic.context.liveDelta.maxChars', 9000)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // SUPERSEDED — the assertion, not the intent.
  //
  // This case used to write a (descriptor-patched) NON-globalOnly key at the
  // DEFAULT `system` scope as a tenant admin and expect success. That success
  // only ever existed against the mock: a `system`-scope write persists on the
  // reserved platform tenant, and the Prisma tenant-scope extension refuses a
  // `GlobalSetting` create whose `tenantId` is not the caller's CLS tenant — so
  // in a running gateway the same call raised `TenantScope: tenantId mismatch`
  // as a bare 500. That is now the intended answer (403: a
  // platform-wide write is a super-admin surface) and gives a tenant admin the
  // scope it can actually write at.
  //
  // The INTENT is preserved verbatim: prove the guard reads descriptor
  // metadata rather than a hard-coded key list, by exercising a key whose
  // descriptor says a tenant admin may set it.
  it('derives the rule from descriptor metadata, not a hard-coded key list', async () => {
    const { svc } = makeService({ roles: [] });
    // `rateLimit.maxRequests` — global-kv, NOT globalOnly, maxScope 'tenant'.
    await expect(svc.write('rateLimit.maxRequests', 10, { scope: 'tenant' })).resolves.toBeDefined();

    // …and the same caller is still refused a key the descriptor marks global-only.
    await expect(svc.write('agentic.context.liveDelta.maxChars', 9000)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a globalOnly key for a super admin', async () => {
    const { svc } = makeService({ roles: ['SUPER_ADMIN'] });
    await expect(svc.write('agentic.context.liveDelta.maxChars', 9000)).resolves.toBeDefined();
  });
});

// ===========================================================================
// 10. maxScope clamp — assertWithinMaxScope is THE enforcement point
// ===========================================================================

describe('SettingsRegistryWriteService — maxScope clamp', () => {
  it('routes the clamp through SettingsRegistry.assertWithinMaxScope', async () => {
    const spy = vi.spyOn(HOPE_SETTINGS_REGISTRY, 'assertWithinMaxScope');
    const { svc } = makeService();
    await svc.write('agentic.context.liveDelta.maxChars', 9000);
    expect(spy).toHaveBeenCalledWith('agentic.context.liveDelta.maxChars', 'system');
  });

  it('rejects a write deeper than the descriptor maxScope with 400', async () => {
    const { svc } = makeService();
    // The key is capped at `system`; asking for `tenant` is deeper.
    await expect(svc.write('agentic.context.liveDelta.maxChars', 9000, { scope: 'tenant' })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

// ===========================================================================
// 11. Key/tier/type gates + the successful write
// ===========================================================================

describe('SettingsRegistryWriteService — gates and persistence', () => {
  it('rejects an unknown key with 400', async () => {
    const { svc } = makeService();
    await expect(svc.write('does.not.exist', 1)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('rejects a secret-sensitivity key with 400 (secrets never flow through this lane)', async () => {
    const secretKey = HOPE_SETTINGS_REGISTRY.list().find((d) => d.sensitivity === 'secret');
    expect(secretKey, 'expected at least one secret-sensitivity descriptor').toBeDefined();
    const { svc } = makeService();
    await expect(svc.write(secretKey!.key, 'anything')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('rejects a non-global-kv tier with 400 (those keep their dedicated services)', async () => {
    const dbConfigKey = HOPE_SETTINGS_REGISTRY.list().find((d) => d.tier === 'db-config' && d.sensitivity !== 'secret');
    expect(dbConfigKey, 'expected at least one db-config descriptor').toBeDefined();
    const { svc } = makeService();
    await expect(svc.write(dbConfigKey!.key, true)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('rejects a value whose type contradicts the descriptor dataType', async () => {
    const { svc } = makeService();
    await expect(svc.write('agentic.context.liveDelta.maxChars', 'not-a-number')).rejects.toBeInstanceOf(ArgumentInvalidException);
    await expect(svc.write('rate-limit.enabled', 'yes-please')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('CREATES the backing GlobalSetting row under the reserved registry namespace', async () => {
    const { svc, globalSettings, appSettings } = makeService();
    await svc.write('agentic.context.liveDelta.maxChars', 9000);

    expect(globalSettings.create).toHaveBeenCalledTimes(1);
    const payload = globalSettings.create.mock.calls[0][0];
    expect(payload.key).toBe('agentic.context.liveDelta.maxChars');
    expect(payload.namespace).toBe('registry');
    expect(payload.value).toBe('9000');
    expect(payload.dataType).toBe(ValueType.Integer);
    expect(appSettings.refreshCache).toHaveBeenCalledTimes(1);
  });

  // A write against an EXISTING row now requires the caller's
  // observed version (If-Match). Before B2 the service silently supplied the
  // cached version itself, which is what let two concurrent edits clobber each
  // other; the precondition is now the caller's to state.
  it('UPDATES the existing row under optimistic concurrency when the caller supplies its version', async () => {
    const { svc, globalSettings } = makeService({ cached: { id: 'gs-42', version: 7 } });
    await svc.write('agentic.context.liveDelta.maxChars', 9000, { expectedVersion: 7 });

    expect(globalSettings.update).toHaveBeenCalledWith('gs-42', expect.objectContaining({ expectedVersion: 7 }));
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('broadcasts ResourceUpdated and refreshes the consumer cache', async () => {
    const { svc, emitter, appSettings } = makeService();
    await svc.write('agentic.context.liveDelta.maxChars', 9000);
    expect(emitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.anything());
    expect(appSettings.refreshCache).toHaveBeenCalledTimes(1);
  });

  it('coerces a boolean value to its string representation for the KV row', async () => {
    const { svc, globalSettings } = makeService();
    await svc.write('rate-limit.enabled', false);
    const payload = globalSettings.create.mock.calls[0][0];
    expect(payload.value).toBe('false');
    expect(payload.dataType).toBe(ValueType.Boolean);
  });
});

// ===========================================================================
// 13. Boot-time kill-switch governance guard
// ===========================================================================

describe('Registry kill-switch governance', () => {
  it('passes for the assembled catalog as shipped', () => {
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
  });

  it('registers rate-limit.enabled default-ON WITHOUT the killSwitch marker', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow('rate-limit.enabled');
    expect(d.default).toBe(true);
    // A protection-enable flag, not an enforcement kill-switch — marking it
    // would violate the "kill-switches default OFF" invariant at boot.
    expect(d.killSwitch).toBeUndefined();
  });

  it.each(['audit-retention.enabled', 'agentic.trajectory.enabled'])('registers %s as a kill-switch defaulting OFF', (key) => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
    expect(d.killSwitch).toBe(true);
    expect(d.default).toBe(false);
  });

  it.each([
    ['rate-limit.enabled', true],
    ['audit-retention.cron', '0 3 * * *'],
    ['audit-retention.retention-days', 365],
    ['audit-retention.batch-size', 1000],
    ['audit-retention.max-batches-per-run', 1000],
    ['agentic.trajectory.cron', '0 4 * * *'],
    ['agentic.trajectory.retentionDays', 30],
  ])('registers %s at its CURRENT runtime default (zero behaviour change)', (key, expected) => {
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key as string).default).toEqual(expected);
  });
});
