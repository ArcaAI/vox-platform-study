/**
 * F-007 follow-up — cross-instance convergence via Redis pub/sub.
 *
 * The `@OnEvent(SysEventType.ResourceUpdated)` subscriber added for F-007
 * (`appSettings.service.sysevent-invalidation.test.ts`) only converges the
 * WRITING instance's own in-process cache — `@nestjs/event-emitter` is
 * in-process only. On a multi-instance deployment every OTHER instance still
 * waits for the once-a-minute cron (`'45 * * * * *'`, worst case ~60s).
 *
 * This closes that gap with a dedicated Redis pub/sub channel:
 *   - after a same-instance refresh succeeds, publish an invalidation
 *     message on `APP_SETTINGS_INVALIDATION_CHANNEL` via `IRedisCacheService`;
 *   - subscribe to that channel on `onModuleInit` via `RedisSubscriberService`
 *     and call `refreshCache()` on receipt;
 *   - a self-published message (same in-memory `instanceId`) is a no-op —
 *     this instance already refreshed itself via the sys-event handler;
 *   - absent/unavailable Redis degrades to the pre-existing behaviour
 *     (in-process convergence + cron) without throwing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import { AppSettingsService, APP_SETTINGS_INVALIDATION_CHANNEL } from '../appSettings.service';
import { GlobalSettingFactory, ResourceType, SysEvent, SysEventType, ValueType } from '@arcaai/domains';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const KEY = 'f007.cross-instance.key';

const buildSetting = (value: string) =>
  GlobalSettingFactory.CreateGlobalSetting({
    tenantId: GLOBAL_TENANT_ID,
    key: KEY,
    value,
    dataType: ValueType.String,
    defaultValue: '',
    name: KEY,
    namespace: 'com.flw.test',
    description: '',
    locked: false,
  });

const repo = { findAll: vi.fn() };
const events = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn(),
  // `cacheAppSettings` reads outside the request CLS context; pass through.
  exit: <T,>(fn: () => T): T => fn(),
};
const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

const buildResourceUpdatedEvent = (resourceType: ResourceType): SysEvent =>
  ({ type: SysEventType.ResourceUpdated, resourceType, tenantId: GLOBAL_TENANT_ID }) as SysEvent;

const buildRedisCache = () => ({ publish: vi.fn().mockResolvedValue(undefined) });

const buildRedisSubscriber = () => {
  const subject = new Subject<string>();
  return {
    mock: { subscribeToChannel: vi.fn().mockResolvedValue(subject.asObservable()) },
    subject,
  };
};

describe('AppSettingsService — cross-instance convergence via Redis pub/sub (F-007 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes an invalidation message on the dedicated channel after a same-instance GlobalSetting refresh', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const redisCache = buildRedisCache();
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never, redisCache as never, undefined);
    await svc.cacheAppSettings();

    await svc.handleGlobalSettingUpdated(buildResourceUpdatedEvent(ResourceType.GlobalSetting));

    expect(redisCache.publish).toHaveBeenCalledTimes(1);
    const [channel, message] = redisCache.publish.mock.calls[0];
    expect(channel).toBe(APP_SETTINGS_INVALIDATION_CHANNEL);
    expect(() => JSON.parse(message)).not.toThrow();
    expect(JSON.parse(message)).toHaveProperty('instanceId');
  });

  it('does not publish for an unrelated resource type', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const redisCache = buildRedisCache();
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never, redisCache as never, undefined);
    await svc.cacheAppSettings();

    await svc.handleGlobalSettingUpdated(buildResourceUpdatedEvent(ResourceType.Department));

    expect(redisCache.publish).not.toHaveBeenCalled();
  });

  it('tolerates a missing Redis cache service — no publish attempt, no throw (fail-open)', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
    await svc.cacheAppSettings();

    await expect(svc.handleGlobalSettingUpdated(buildResourceUpdatedEvent(ResourceType.GlobalSetting))).resolves.toBeUndefined();
  });

  it('subscribes to the invalidation channel on init and refreshes the cache when a peer instance publishes', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const { mock: redisSubscriber, subject } = buildRedisSubscriber();
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never, undefined, redisSubscriber as never);

    await svc.onModuleInit();
    expect(redisSubscriber.subscribeToChannel).toHaveBeenCalledWith(APP_SETTINGS_INVALIDATION_CHANNEL);
    expect(svc.getValueWithDefault(KEY, 'fallback')).toBe('initial');

    repo.findAll.mockResolvedValue([buildSetting('updated-by-peer')]);
    repo.findAll.mockClear();

    subject.next(JSON.stringify({ instanceId: 'some-other-instance' }));

    await vi.waitFor(() => expect(repo.findAll).toHaveBeenCalledTimes(1));
    expect(svc.getValueWithDefault(KEY, 'fallback')).toBe('updated-by-peer');
  });

  it('skips a self-published invalidation message (no redundant refresh)', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const redisCache = buildRedisCache();
    const { mock: redisSubscriber, subject } = buildRedisSubscriber();
    const svc = new AppSettingsService(
      repo as never,
      events as never,
      cls as never,
      scheduler as never,
      redisCache as never,
      redisSubscriber as never,
    );

    await svc.onModuleInit();

    // Trigger the same-instance path: refreshes locally AND publishes with this
    // instance's own instanceId.
    repo.findAll.mockResolvedValue([buildSetting('updated-locally')]);
    repo.findAll.mockClear();
    await svc.handleGlobalSettingUpdated(buildResourceUpdatedEvent(ResourceType.GlobalSetting));
    expect(repo.findAll).toHaveBeenCalledTimes(1);
    const [, selfMessage] = redisCache.publish.mock.calls[0];

    // Simulate that message looping back through this instance's own subscription
    // (Redis pub/sub delivers to every subscriber on the channel, including the
    // publisher's own separate subscriber connection).
    repo.findAll.mockClear();
    subject.next(selfMessage);

    // Give any (incorrect) async refresh a chance to run before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(repo.findAll).not.toHaveBeenCalled();
  });

  it('degrades cleanly when the subscriber is unavailable — still boots, no throw', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('refreshes defensively when a malformed invalidation message is received (never throws)', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const { mock: redisSubscriber, subject } = buildRedisSubscriber();
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never, undefined, redisSubscriber as never);

    await svc.onModuleInit();
    repo.findAll.mockResolvedValue([buildSetting('after-malformed-message')]);
    repo.findAll.mockClear();

    subject.next('not-json');

    await vi.waitFor(() => expect(repo.findAll).toHaveBeenCalledTimes(1));
  });
});
