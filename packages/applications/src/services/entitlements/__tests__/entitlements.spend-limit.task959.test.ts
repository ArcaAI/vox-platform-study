/**
 * TASK-959 FU-1 (TASK-957 F-4) — the tenant spend ceiling gets a write path.
 *
 * `monthlySpendLimitMicros` has been enforced since F-4 (402 on the agent and
 * workflow planes, and on consultation summaries before that) and settable by
 * nobody: `task-959-spend-limit.spec.ts` had to write the column through the
 * unscoped platform client to build its own fixture. This file pins the write
 * path the override PUT now carries.
 *
 * Three things are asserted, and the third is the one that is not obvious:
 *
 *  - the ceiling is created, updated and CLEARED through the same `BigInt?`
 *    handling as its five sibling allowance columns;
 *  - `0` survives as `0n`. It is the honest "spend nothing more this month"
 *    setting, and a `??`/falsy-guarded assignment would silently turn it into
 *    "unlimited" — the failure direction that costs money;
 *  - the SYSTEM tenant is refused, for EVERYONE including a platform admin.
 *    `00000000-…` is a configuration TIER, not a customer: no request runs as
 *    it, so `assertSpendLimit` would never read such a row and the ceiling
 *    would be dead data that LOOKS set. `EntitlementsLifecycleService
 *    .triggerDowngrade` already refuses the same tenant the same way.
 *
 * The ROUTE's own gate is unchanged and deliberately not widened here: the
 * override PUT is `@Authorize(['manage','all'])` — super-admin only, pinned by
 * `apps/api/src/modules/entitlements/__tests__/entitlements-admin.controller.test.ts`.
 * Tenant-admin self-service on a tenant's OWN ceiling is an owner decision, not
 * a side effect of adding the field.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { EntitlementsService } from '../entitlements.service';
import { ENTITLEMENTS_TENANT_ID } from '../entitlements.constants';

const tenantRepository = { findById: vi.fn() };
const planEntitlementRepository = { findByPlan: vi.fn(), findAll: vi.fn(), updateWithVersion: vi.fn() };
const tenantEntitlementRepository = { findByTenant: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn() };
const apiKeyRepository = { count: vi.fn() };
const tenantService = { getUsageStats: vi.fn() };
const metering = { getCurrentUsage: vi.fn() };
const appSettings = { getFromCache: vi.fn(), getValueWithDefault: vi.fn((_k: string, d: unknown) => d), refreshCache: vi.fn() };
const globalSettings = { update: vi.fn(), create: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const clsService = { get: vi.fn(() => undefined) };
const socketRegistry = { getTenantAggregateCount: vi.fn() };
const metricsService = { createCounter: vi.fn(() => ({ inc: vi.fn() })) };

const makeService = () =>
  new EntitlementsService(
    tenantRepository as never,
    planEntitlementRepository as never,
    tenantEntitlementRepository as never,
    apiKeyRepository as never,
    tenantService as never,
    metering as never,
    appSettings as never,
    globalSettings as never,
    eventEmitter as never,
    clsService as never,
    socketRegistry as never,
    metricsService as never,
  );

const fakeTenantEntity = (o: Record<string, unknown> = {}) => ({
  id: 'te-1',
  tenantId: 'tenant-1',
  maxUsers: null,
  storageQuotaBytes: null as bigint | null,
  monthlySttSessionSeconds: null as bigint | null,
  monthlyLlmTokens: null as bigint | null,
  monthlyTtsCharacters: null as bigint | null,
  monthlyNlpTextUnits: null as bigint | null,
  monthlyEmbeddingTokens: null as bigint | null,
  monthlySpendLimitMicros: null as bigint | null,
  version: 2,
  updatedBy: null,
  toObject: () => ({}),
  ...o,
});

describe('EntitlementsService — monthlySpendLimitMicros (FU-1)', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('create', () => {
    beforeEach(() => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantRepository.findById.mockResolvedValue({ id: 'tenant-1' });
      tenantEntitlementRepository.create.mockImplementation(async (entity: unknown) => entity);
    });

    it('writes the first ceiling as a bigint and echoes it as a number', async () => {
      const res = await makeService().upsertTenantEntitlement('tenant-1', { monthlySpendLimitMicros: 250_000_000 });

      const created = tenantEntitlementRepository.create.mock.calls[0][0];
      expect(created.monthlySpendLimitMicros).toBe(BigInt(250_000_000));
      expect(res.monthlySpendLimitMicros).toBe(250_000_000);
    });

    it('keeps a zero ceiling as 0n — "spend nothing more", never "unlimited"', async () => {
      const res = await makeService().upsertTenantEntitlement('tenant-1', { monthlySpendLimitMicros: 0 });

      const created = tenantEntitlementRepository.create.mock.calls[0][0];
      expect(created.monthlySpendLimitMicros).toBe(BigInt(0));
      expect(res.monthlySpendLimitMicros).toBe(0);
    });

    it('leaves the ceiling null when the caller named no ceiling', async () => {
      await makeService().upsertTenantEntitlement('tenant-1', { maxUsers: 5 });

      expect(tenantEntitlementRepository.create.mock.calls[0][0].monthlySpendLimitMicros).toBeNull();
    });
  });

  describe('update', () => {
    it('raises an existing ceiling under OCC', async () => {
      const row = fakeTenantEntity({ version: 7, monthlySpendLimitMicros: BigInt(1_000) });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { monthlySpendLimitMicros: 9_000, expectedVersion: 7 });

      expect(row.monthlySpendLimitMicros).toBe(BigInt(9_000));
      expect(tenantEntitlementRepository.updateWithVersion).toHaveBeenCalledWith('te-1', row, 7);
      expect(res.monthlySpendLimitMicros).toBe(9_000);
    });

    it('clears the ceiling back to unlimited with an explicit null', async () => {
      const row = fakeTenantEntity({ version: 4, monthlySpendLimitMicros: BigInt(5_000) });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { monthlySpendLimitMicros: null, expectedVersion: 4 });

      expect(row.monthlySpendLimitMicros).toBeNull();
      expect(res.monthlySpendLimitMicros).toBeNull();
    });

    it('leaves an existing ceiling untouched when the PUT does not name it', async () => {
      const row = fakeTenantEntity({ version: 4, monthlySpendLimitMicros: BigInt(5_000) });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);

      await makeService().upsertTenantEntitlement('tenant-1', { maxUsers: 3, expectedVersion: 4 });

      expect(row.monthlySpendLimitMicros).toBe(BigInt(5_000));
    });
  });

  describe('clear', () => {
    it('nulls the ceiling along with every other override', async () => {
      const row = fakeTenantEntity({ monthlySpendLimitMicros: BigInt(5_000) });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);

      await makeService().clearTenantEntitlement('tenant-1');

      expect(row.monthlySpendLimitMicros).toBeNull();
    });
  });

  describe('the platform tier is not a valid target', () => {
    it('refuses an override on the SYSTEM tenant, platform admin or not', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      await expect(makeService().upsertTenantEntitlement(ENTITLEMENTS_TENANT_ID, { monthlySpendLimitMicros: 1 })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(tenantEntitlementRepository.create).not.toHaveBeenCalled();
      expect(tenantEntitlementRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('refuses before it looks anything up — the answer cannot vary by row', async () => {
      await expect(makeService().upsertTenantEntitlement(ENTITLEMENTS_TENANT_ID, { maxUsers: 1 })).rejects.toBeInstanceOf(ForbiddenException);
      expect(tenantEntitlementRepository.findByTenant).not.toHaveBeenCalled();
      expect(tenantRepository.findById).not.toHaveBeenCalled();
    });

    it('still allows a customer tenant', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantRepository.findById.mockResolvedValue({ id: 'tenant-1' });
      tenantEntitlementRepository.create.mockImplementation(async (entity: unknown) => entity);

      await expect(makeService().upsertTenantEntitlement('tenant-1', { monthlySpendLimitMicros: 1 })).resolves.toBeDefined();
    });
  });
});
