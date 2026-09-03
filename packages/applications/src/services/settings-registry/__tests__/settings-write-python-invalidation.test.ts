/**
 * RC-6 — the settings write lane must PUBLISH an invalidation the Python
 * services can act on.
 *
 * Before this, `arca:guardrail-config:invalidate` appeared exactly once
 * repo-wide (guardrail's SUBSCRIBER) and had ZERO publishers, so every Python
 * service converged by 60s poll. Rule 09: "Invalidation is the
 * propagation path; TTL is a bounded-staleness safety net."
 *
 * This pins the PUBLISH half. The SUBSCRIBE half is pinned per service in
 * Python (`test_config_invalidation.py` in each suite).
 *
 * The channel is deliberately ONE generalised name, not six bespoke ones — see
 * `PYTHON_CONFIG_INVALIDATION_CHANNEL`'s docblock.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { PYTHON_CONFIG_INVALIDATION_CHANNEL, SettingsRegistryWriteService } from '../settings-registry-write.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** A real `global-kv`, `globalOnly` registry key (writable through this lane). */
const KEY = 'rate-limit.enabled';

function makeService(opts: { redisCache?: any } = {}) {
  const appSettings = {
    getFromCache: vi.fn().mockReturnValue(undefined),
    getValueFromCache: vi.fn().mockReturnValue(null),
    getValueWithDefault: vi.fn((_k: string, d: unknown) => d),
    refreshCache: vi.fn().mockResolvedValue(undefined),
  };
  const globalSettings = {
    create: vi.fn(async () => ({ id: 'gs-1', version: 1 })),
    update: vi.fn(async () => ({ id: 'gs-1', version: 2 })),
  };
  const emitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: ['SUPER_ADMIN'], tenantId: SYSTEM_TENANT_ID } : undefined)),
    set: vi.fn(),
    run: vi.fn(async (fn: () => unknown) => fn()),
  };
  const globalSettingRepository = { findFirst: vi.fn(async () => null) };

  const svc = new SettingsRegistryWriteService(
    appSettings as any,
    globalSettings as any,
    emitter as any,
    cls as any,
    globalSettingRepository as any,
    opts.redisCache,
  );
  return { svc, appSettings };
}

describe('settings write lane → Python config invalidation', () => {
  it('publishes the written key on the generalised channel', async () => {
    const redisCache = { publish: vi.fn().mockResolvedValue(undefined) };
    const { svc } = makeService({ redisCache });

    await svc.write(KEY, true);

    expect(redisCache.publish).toHaveBeenCalledTimes(1);
    const [channel, message] = redisCache.publish.mock.calls[0];
    expect(channel).toBe(PYTHON_CONFIG_INVALIDATION_CHANNEL);
    expect(JSON.parse(message as string)).toEqual({ key: KEY, scope: 'system', tenantId: SYSTEM_TENANT_ID });
  });

  it('publishes AFTER the read cache is refreshed, so a refetch cannot read the old value', async () => {
    const order: string[] = [];
    const redisCache = { publish: vi.fn(async () => void order.push('publish')) };
    const { svc, appSettings } = makeService({ redisCache });
    appSettings.refreshCache.mockImplementation(async () => void order.push('refreshCache'));

    await svc.write(KEY, true);

    expect(order).toEqual(['refreshCache', 'publish']);
  });

  it('fails OPEN when Redis is unavailable — the write still succeeds (TTL remains the backstop)', async () => {
    const redisCache = { publish: vi.fn().mockRejectedValue(new Error('redis down')) };
    const { svc } = makeService({ redisCache });

    await expect(svc.write(KEY, true)).resolves.toMatchObject({ key: KEY, version: 1 });
  });

  it('is optional — a service graph with no Redis publisher still writes', async () => {
    const { svc } = makeService({});
    await expect(svc.write(KEY, true)).resolves.toMatchObject({ key: KEY });
  });
});
