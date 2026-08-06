/**
 * Billing controllers unit tests (TASK-615 WS-I).
 *
 * CASL `@CanManage`/`@Authorize` + `If-Match`/`@RequiresIfMatch` are exercised
 * by the guard/interceptor pipeline (+ e2e). These specs cover the
 * controllers' OWN logic: tenant scoping (global-admin `?tenantId=` vs pinned
 * tenant caller — the 403-on-foreign-query posture of `resolveScopedTenantId`),
 * self-service pinning to the CLS tenant, default-period behavior, and plain
 * delegation. The cross-tenant BY-ID 404 posture is proven at the service
 * layer (`billing.service.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import 'reflect-metadata';

import { BillingAdminController } from '../billing-admin.controller';
import { MyBillingController } from '../my-billing.controller';
import { RateCardAdminController } from '../rate-card-admin.controller';

type Ctx = { user?: { roles?: string[] | null; tenantId?: string } | null; tenantId?: string };
const SUPER: Ctx['user'] = { roles: ['GLOBAL_ADMIN'] };
const TENANT_ADMIN = (tenantId: string): Ctx['user'] => ({ roles: ['TENANT_ADMIN'], tenantId });

function makeBillingService() {
  return {
    computeDraft: vi.fn().mockResolvedValue({}),
    getInvoice: vi.fn().mockResolvedValue({}),
    listInvoices: vi.fn().mockResolvedValue([]),
    finalize: vi.fn().mockResolvedValue({}),
    voidDraft: vi.fn().mockResolvedValue({}),
    addAdjustment: vi.fn().mockResolvedValue({}),
    getSpendStatus: vi.fn().mockResolvedValue({}),
  };
}

function makeCls(ctx: Ctx) {
  return { get: vi.fn((key: string) => (ctx as Record<string, unknown>)[key]) };
}

const INVOICE_ID = '01912345-0000-7000-8000-000000000001';

describe('BillingAdminController — tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('global admin acts cross-tenant via ?tenantId=', async () => {
    const service = makeBillingService();
    const controller = new BillingAdminController(service as never, makeCls({ user: SUPER, tenantId: undefined }) as never);

    await controller.list('tenant-9');
    expect(service.listInvoices).toHaveBeenCalledWith('tenant-9', undefined);

    await controller.finalize(INVOICE_ID, 3, 'tenant-9');
    expect(service.finalize).toHaveBeenCalledWith('tenant-9', INVOICE_ID, 3);
  });

  it('global admin without a target tenant gets a 400 telling them to pass ?tenantId=', async () => {
    const service = makeBillingService();
    const controller = new BillingAdminController(service as never, makeCls({ user: SUPER, tenantId: undefined }) as never);
    expect(() => controller.list(undefined)).toThrow(BadRequestException);
  });

  it('a tenant-bound caller is pinned; a FOREIGN ?tenantId= is rejected (403)', async () => {
    const service = makeBillingService();
    const controller = new BillingAdminController(service as never, makeCls({ user: TENANT_ADMIN('t1'), tenantId: 't1' }) as never);

    await controller.get(INVOICE_ID, undefined);
    expect(service.getInvoice).toHaveBeenCalledWith('t1', INVOICE_ID);

    expect(() => controller.get(INVOICE_ID, 't2')).toThrow(ForbiddenException);
  });

  it('compute-draft and adjustments delegate with the request payload', async () => {
    const service = makeBillingService();
    const controller = new BillingAdminController(service as never, makeCls({ user: SUPER }) as never);

    await controller.computeDraft({ tenantId: 'tenant-9', period: '2026-08' } as never);
    expect(service.computeDraft).toHaveBeenCalledWith('tenant-9', '2026-08');

    const memo = { reason: 'sla_credit', amountMicros: '-1' };
    await controller.addAdjustment(INVOICE_ID, memo as never, 'tenant-9');
    expect(service.addAdjustment).toHaveBeenCalledWith('tenant-9', INVOICE_ID, memo);

    await controller.spendStatus('2026-08', 'tenant-9');
    expect(service.getSpendStatus).toHaveBeenCalledWith('tenant-9', '2026-08');
  });
});

describe('MyBillingController — self-service pinning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
  });

  it('always reads the CLS tenant — there is no tenant parameter to override', async () => {
    const service = makeBillingService();
    const controller = new MyBillingController(service as never, makeCls({ user: TENANT_ADMIN('t1'), tenantId: 't1' }) as never);

    await controller.listMine();
    expect(service.listInvoices).toHaveBeenCalledWith('t1');

    await controller.getMine(INVOICE_ID);
    expect(service.getInvoice).toHaveBeenCalledWith('t1', INVOICE_ID);
  });

  it('spend defaults to the CURRENT UTC period when none is given', async () => {
    const service = makeBillingService();
    const controller = new MyBillingController(service as never, makeCls({ user: TENANT_ADMIN('t1'), tenantId: 't1' }) as never);

    await controller.spend(undefined);
    expect(service.getSpendStatus).toHaveBeenCalledWith('t1', '2026-08');

    await controller.spend('2026-07');
    expect(service.getSpendStatus).toHaveBeenCalledWith('t1', '2026-07');
  });

  it('400s without a tenant context (an unscoped global admin belongs on /admin/billing)', async () => {
    const service = makeBillingService();
    const controller = new MyBillingController(service as never, makeCls({ user: SUPER, tenantId: undefined }) as never);
    expect(() => controller.listMine()).toThrow(BadRequestException);
    expect(service.listInvoices).not.toHaveBeenCalled();
  });
});

describe('RateCardAdminController — delegation + supersede-only shape', () => {
  it('delegates list/create/supersede and exposes NO in-place mutation route', async () => {
    const service = {
      listSellRates: vi.fn().mockResolvedValue([]),
      createSellRate: vi.fn().mockResolvedValue({}),
      supersedeSellRate: vi.fn().mockResolvedValue({}),
    };
    const controller = new RateCardAdminController(service as never);

    await controller.list(undefined, undefined, undefined, undefined, undefined);
    expect(service.listSellRates).toHaveBeenCalledWith({ tenantId: undefined, rowKind: undefined, capability: undefined, unit: undefined, planTier: undefined });

    await controller.supersede(INVOICE_ID, { unitPriceMicros: '8', effectiveFrom: '2026-09-01T00:00:00.000Z', bookVersion: 'v2' } as never, 4);
    expect(service.supersedeSellRate).toHaveBeenCalledWith(INVOICE_ID, expect.anything(), 4);

    // Supersede-only: no PATCH/PUT/DELETE handler exists on the controller.
    const proto = Object.getOwnPropertyNames(RateCardAdminController.prototype);
    expect(proto.sort()).toEqual(['constructor', 'create', 'list', 'supersede'].sort());
  });
});
