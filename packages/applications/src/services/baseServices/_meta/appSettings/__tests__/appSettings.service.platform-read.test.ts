/**
 * The cache refresh is a PLATFORM read, not a request read.
 *
 * `cacheAppSettings()` loads BOTH lanes — the platform key-only map and every
 * customer tenant's `registry` overrides — from a single
 * `globalSettingRepository.findAll({})`. That read is served by the
 * tenant-scope Prisma extension, which filters by the AMBIENT CLS tenant and
 * passes through only when NO tenant is in context (SUPER_ADMIN is not a
 * bypass once a tenant is set).
 *
 * So when a refresh is triggered IN-REQUEST — every admin write path does
 * (`RateLimitAdminService`, `SchedulerAdminService`, `SettingsRegistryWriteService`,
 * `EntitlementsService`) — and the caller has a tenant in CLS (a tenant admin,
 * or a super admin with a working tenant selected), the read returns ONLY that
 * tenant's rows and the refresh replaces the platform cache with them. Every
 * platform key then reads as absent process-wide until the 45s cron (which runs
 * outside CLS) repairs it. Observed as: a rate-limit write succeeded, the very
 * next write to the same tier took the "key missing from cache" branch and
 * CREATED A DUPLICATE platform row — which the boot-time duplicate-key
 * invariant refuses to start on.
 *
 * The refresh must therefore read OUTSIDE the request's CLS context.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppSettingsService } from '../appSettings.service';
import { GlobalSettingFactory, ValueType } from '@arcaai/domains';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const CUSTOMER_TENANT = '50000000-0000-0000-0000-000000000001';

const buildSetting = (key: string, tenantId: string, value: string) =>
  GlobalSettingFactory.CreateGlobalSetting({
    tenantId,
    key,
    value,
    dataType: ValueType.Integer,
    defaultValue: value,
    name: key,
    namespace: 'rate-limit',
    description: '',
    locked: false,
  });

/** True while the fake CLS context is "exited" (no request store active). */
let insideExit = false;
/** What the repository read saw: was it running outside the request context? */
let readRanOutsideContext: boolean | undefined;

const repo = {
  findAll: vi.fn(async () => {
    readRanOutsideContext = insideExit;
    return [buildSetting('rate-limit.tier.default.limit', GLOBAL_TENANT_ID, '100')];
  }),
};
const events = { emit: vi.fn() };
const cls = {
  get: vi.fn(() => CUSTOMER_TENANT),
  set: vi.fn(),
  exit: vi.fn(async (fn: () => unknown) => {
    insideExit = true;
    try {
      return await fn();
    } finally {
      insideExit = false;
    }
  }),
};
const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

const newService = () => new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);

describe('AppSettingsService — refresh is a platform read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insideExit = false;
    readRanOutsideContext = undefined;
    delete process.env.APP_SETTINGS_BOOT_INVARIANT;
    process.env.NODE_ENV = 'production';
  });

  it('reads settings outside the caller CLS context, so a working tenant cannot scope it', async () => {
    const service = newService();
    await service.cacheAppSettings();

    expect(readRanOutsideContext).toBe(true);
  });

  it('still populates the platform lane when a customer tenant is active in CLS', async () => {
    const service = newService();
    await service.cacheAppSettings();

    expect(service.hasSetting('rate-limit.tier.default.limit')).toBe(true);
  });
});
