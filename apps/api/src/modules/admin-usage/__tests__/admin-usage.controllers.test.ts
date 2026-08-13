/**
 * Usage-analytics controllers unit tests.
 *
 * `@CanManage`/`@Authorize` are exercised by the guard pipeline (+ e2e). These
 * specs cover the controllers' OWN logic: tenant scoping (global-admin
 * `?tenantId=` vs a pinned tenant caller — the 403-on-foreign-query posture of
 * `resolveScopedTenantId`), self-service pinning to the CLS tenant with no
 * tenant override, default-period behavior, and plain delegation. The
 * cross-tenant BY-ID 404 posture and the GLOBAL_ADMIN gate on `top-tenants`
 * are proven at the service layer (`usage-analytics.service.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import 'reflect-metadata';
import { AiCapability, AiUsageUnit } from '@arcaai/domains';

import { AdminUsageController } from '../admin-usage.controller';
import { MyUsageController } from '../my-usage.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['GLOBAL_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeUsageAnalyticsService() {
  return {
    getUsageSummary: vi.fn().mockResolvedValue({}),
    getUsageTimeseries: vi.fn().mockResolvedValue({}),
    getCostPerEncounter: vi.fn().mockResolvedValue({}),
    getTopTenants: vi.fn().mockResolvedValue({}),
    getBudgetBurndown: vi.fn().mockResolvedValue({}),
  };
}

function makeCls(ctx: Ctx) {
  return { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
}

describe('AdminUsageController — tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
  });

  it('global admin acts cross-tenant via ?tenantId=', async () => {
    const service = makeUsageAnalyticsService();
    const controller = new AdminUsageController(service as never, makeCls({ user: SUPER, tenantId: undefined }) as never);

    await controller.summary({ period: '2026-07', tenantId: 'tenant-9' });
    expect(service.getUsageSummary).toHaveBeenCalledWith('tenant-9', '2026-07');
  });

  it('global admin without a target tenant gets a 400 telling them to pass ?tenantId=', () => {
    const service = makeUsageAnalyticsService();
    const controller = new AdminUsageController(service as never, makeCls({ user: SUPER, tenantId: undefined }) as never);
    expect(() => controller.summary({})).toThrow(BadRequestException);
  });

  it('a tenant-bound caller is pinned; a FOREIGN ?tenantId= is rejected (403)', async () => {
    const service = makeUsageAnalyticsService();
    const controller = new AdminUsageController(service as never, makeCls({ user: TENANT_ADMIN('t1'), tenantId: 't1' }) as never);

    await controller.costPerEncounter({ period: '2026-07' });
    expect(service.getCostPerEncounter).toHaveBeenCalledWith('t1', '2026-07');

    expect(() => controller.costPerEncounter({ period: '2026-07', tenantId: 't2' })).toThrow(ForbiddenException);
  });

  it('summary/cost-per-encounter default the period to the current UTC month when omitted', async () => {
    const service = makeUsageAnalyticsService();
    const controller = new AdminUsageController(service as never, makeCls({ user: SUPER, tenantId: 'tenant-9' }) as never);

    await controller.summary({});
    expect(service.getUsageSummary).toHaveBeenCalledWith('tenant-9', '2026-08');

    await controller.costPerEncounter({});
    expect(service.getCostPerEncounter).toHaveBeenCalledWith('tenant-9', '2026-08');
  });

  it('timeseries converts ISO strings to Date and passes the tuple through', async () => {
    const service = makeUsageAnalyticsService();
    const controller = new AdminUsageController(service as never, makeCls({ user: SUPER, tenantId: 'tenant-9' }) as never);

    await controller.timeseries({
      capability: AiCapability.STT,
      unit: AiUsageUnit.AUDIO_SECOND,
      granularity: 'day',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-05T00:00:00.000Z',
    });

    expect(service.getUsageTimeseries).toHaveBeenCalledWith('tenant-9', {
      capability: AiCapability.STT,
      unit: AiUsageUnit.AUDIO_SECOND,
      granularity: 'day',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-05T00:00:00.000Z'),
    });
  });

  it('top-tenants is NOT tenant-scoped — it delegates period/limit/capability straight through', async () => {
    const service = makeUsageAnalyticsService();
    const controller = new AdminUsageController(service as never, makeCls({ user: SUPER }) as never);

    await controller.topTenants({ period: '2026-07', limit: 5, capability: AiCapability.LLM });
    expect(service.getTopTenants).toHaveBeenCalledWith('2026-07', { limit: 5, capability: AiCapability.LLM });

    await controller.topTenants({});
    expect(service.getTopTenants).toHaveBeenCalledWith('2026-08', { limit: 10, capability: undefined });
  });
});

describe('MyUsageController — self-service pinning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
  });

  it('always reads the CLS tenant — there is no tenant parameter to override', async () => {
    const service = makeUsageAnalyticsService();
    const controller = new MyUsageController(service as never, makeCls({ user: TENANT_ADMIN('t1'), tenantId: 't1' }) as never);

    await controller.summary({});
    expect(service.getUsageSummary).toHaveBeenCalledWith('t1', '2026-08');

    await controller.burndown({ period: '2026-06' });
    expect(service.getBudgetBurndown).toHaveBeenCalledWith('t1', '2026-06');
  });

  it('refuses without a tenant context (global admin with no working tenant)', () => {
    const service = makeUsageAnalyticsService();
    const controller = new MyUsageController(service as never, makeCls({ user: SUPER, tenantId: undefined }) as never);
    expect(() => controller.summary({})).toThrow(BadRequestException);
  });
});
