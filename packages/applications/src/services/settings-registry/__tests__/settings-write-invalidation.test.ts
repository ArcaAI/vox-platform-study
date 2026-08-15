/**
 * INVALIDATION PROOF, write lane → second instance.
 *
 * Required evidence: "a settings write evicts the entry on a second
 * node/instance without waiting for the TTL".
 *
 * FINDING (corrects an earlier TTL-based assumption): for the `global-kv` tier the
 * propagation path was ALREADY push-based, not TTL-based — a dedicated
 * `app-settings:invalidate` Redis channel already existed. An earlier assumption
 * was that settings had no invalidation and that TTL was the propagation mechanism; that
 * is stale. Nothing needed to be moved onto the SecretsService channel (whose
 * payload contract is per-key secret eviction, a different concern).
 *
 * What was NOT covered anywhere is the END-TO-END chain, which this test pins:
 *
 *   SettingsRegistryWriteService.write()
 *     → broadcastSysEvent(ResourceUpdated, ResourceType.GlobalSetting)
 *     → [instance A] handleGlobalSettingUpdated → refreshCache() + publish
 *     → [redis channel]
 *     → [instance B] subscriber → refreshCache()
 *
 * The 45s refresh cron is never started here and no timer is advanced, so a
 * converged instance B proves push propagation rather than TTL expiry.
 *
 * `@OnEvent` is bound by Nest's EventEmitterModule at boot via DiscoveryService;
 * with a bare EventEmitter2 the binding is made explicitly below, which is the
 * same wiring Nest performs.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Subject } from 'rxjs';
import { AppSettingsService, APP_SETTINGS_INVALIDATION_CHANNEL } from '../../baseServices/_meta/appSettings/appSettings.service';
import { SettingsRegistryWriteService, REGISTRY_SETTING_NAMESPACE } from '../settings-registry-write.service';
import { GlobalSettingFactory, ResourceType, SysEvent, SysEventType, ValueType } from '@arcaai/domains';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/** A real registry key on the `global-kv` tier (writable through this lane). */
const KEY = 'rate-limit.enabled';

const row = (value: string) =>
  GlobalSettingFactory.CreateGlobalSetting({
    tenantId: GLOBAL_TENANT_ID,
    key: KEY,
    value,
    dataType: ValueType.Boolean,
    defaultValue: 'false',
    name: KEY,
    namespace: REGISTRY_SETTING_NAMESPACE,
    description: '',
    locked: false,
  });

/** An in-memory stand-in for the Redis channel shared by both instances. */
const buildBus = () => {
  const subject = new Subject<string>();
  return {
    cache: { publish: vi.fn(async (_channel: string, message: string) => void subject.next(message)) },
    subscriber: { subscribeToChannel: vi.fn().mockResolvedValue(subject.asObservable()) },
  };
};

// `rate-limit.enabled` is a `globalOnly` descriptor, so the writer must be a
// SUPER_ADMIN (the imperative privilege check in the write lane).
const cls = {
  get: vi.fn((key?: string) => (key === 'user' ? { id: 'global-admin', roles: ['SUPER_ADMIN'], tenantId: GLOBAL_TENANT_ID } : undefined)),
  set: vi.fn(),
};
const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

describe('settings write → cross-instance eviction (no TTL wait)', () => {
  it('converges a SECOND instance from a registry write on the first', async () => {
    const bus = buildBus();

    // Shared "database": both instances read the same rows.
    let stored = row('false');
    const repoA = { findAll: vi.fn(async () => [stored]) };
    const repoB = { findAll: vi.fn(async () => [stored]) };

    // ── instance A (the writer) ────────────────────────────────────────────
    const emitterA = new EventEmitter2();
    const appSettingsA = new AppSettingsService(repoA as never, emitterA as never, cls as never, scheduler as never, bus.cache as never, undefined);
    // Stand in for Nest's @OnEvent binding.
    emitterA.on(SysEventType.ResourceUpdated, (event: SysEvent) => appSettingsA.handleGlobalSettingUpdated(event));
    await appSettingsA.cacheAppSettings();

    // ── instance B (the peer) — subscribes, never writes ───────────────────
    const appSettingsB = new AppSettingsService(
      repoB as never,
      new EventEmitter2() as never,
      cls as never,
      scheduler as never,
      undefined,
      bus.subscriber as never,
    );
    await appSettingsB.onModuleInit();
    expect(bus.subscriber.subscribeToChannel).toHaveBeenCalledWith(APP_SETTINGS_INVALIDATION_CHANNEL);

    // Both instances start agreeing on the old value.
    expect(appSettingsA.getValueWithDefault(KEY, null)).toBe(false);
    expect(appSettingsB.getValueWithDefault(KEY, null)).toBe(false);

    // ── the write ─────────────────────────────────────────────────────────
    const globalSettings = {
      update: vi.fn(async (_id: string, patch: { value: string }) => {
        stored = row(patch.value);
        return { id: stored.id, version: 2 };
      }),
      create: vi.fn(),
    };
    const writeService = new SettingsRegistryWriteService(
      appSettingsA as never,
      globalSettings as never,
      emitterA as never,
      cls as never,
      { findFirst: vi.fn(async () => ({ id: stored.id, version: 1 })) } as never,
    );

    const result = await writeService.write(KEY, true, { scope: 'system', expectedVersion: 1 });
    expect(result.value).toBe(true);

    // The writer converged synchronously through its own refresh.
    expect(appSettingsA.getValueWithDefault(KEY, null)).toBe(true);

    // The PEER converged from the published eviction — no cron was scheduled
    // (scheduler.addCronJob is a no-op mock) and no timer was advanced.
    await vi.waitFor(() => expect(appSettingsB.getValueWithDefault(KEY, null)).toBe(true));

    expect(bus.cache.publish).toHaveBeenCalledWith(APP_SETTINGS_INVALIDATION_CHANNEL, expect.any(String));
  });
});
