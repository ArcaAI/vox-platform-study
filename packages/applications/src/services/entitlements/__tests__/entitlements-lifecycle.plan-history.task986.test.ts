/**
 * TASK-986 (owner ruling D-7) — the two plan-change paths this service owns
 * must leave the same trail `TenantService` does.
 *
 * `BillingService.recordPlanChange` is the ONLY `TenantPlanHistory` writer and
 * it had zero production callers, so the invoice engine prorated plan fees
 * against an empty table; `applyPlanStorageQuota` ran only at tenant creation,
 * so a plan change left the old bucket ceiling in place. Both are wired here
 * for the trial-expiry sweep and the explicit downgrade.
 */
import { describe, it, expect, vi } from 'vitest';
import { TenantPlan } from '@arcaai/domains';
import { EntitlementsLifecycleService } from '../entitlements-lifecycle.service';

const PAST = new Date('2026-03-01T00:00:00.000Z');
const NOW = new Date('2026-03-17T09:41:23.456Z');

function makeCls() {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn((k: string, v: unknown) => store.set(k, v)),
    get: vi.fn((k: string) => store.get(k)),
  };
}

function makeService(tenantRows: Array<Record<string, unknown>>, tenantRow: Record<string, unknown> | null) {
  const baseClient = {
    tenant: {
      findMany: vi.fn().mockResolvedValue(tenantRows),
      findUnique: vi.fn().mockResolvedValue(tenantRow),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const billing = { recordPlanChange: vi.fn().mockResolvedValue(undefined) };
  const tenantBucket = { applyPlanStorageQuota: vi.fn().mockResolvedValue(undefined) };
  const service = new EntitlementsLifecycleService(
    { baseClient } as never,
    { isEnforcementEnabled: vi.fn().mockReturnValue(false), resolveForTenant: vi.fn() } as never,
    { getValueWithDefault: vi.fn((_k: string, fallback: unknown) => fallback) } as never,
    { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never,
    { emit: vi.fn() } as never,
    makeCls() as never,
    billing as never,
    tenantBucket as never,
  );
  return { service, billing, tenantBucket, baseClient };
}

describe('EntitlementsLifecycleService — plan history + storage quota (TASK-986)', () => {
  it('expireTrials records the TRIAL → STARTER transition and re-applies the storage quota', async () => {
    const { service, billing, tenantBucket } = makeService([{ id: 't-expired', plan: TenantPlan.TRIAL, trialEndsAt: PAST, key: 'acme' }], null);

    await service.expireTrials(NOW);

    expect(billing.recordPlanChange).toHaveBeenCalledWith('t-expired', TenantPlan.STARTER, expect.any(Date), expect.any(String));
    expect(tenantBucket.applyPlanStorageQuota).toHaveBeenCalledWith('t-expired', TenantPlan.STARTER);
  });

  it('triggerDowngrade records the new plan and re-applies the storage quota', async () => {
    const { service, billing, tenantBucket } = makeService([], { id: 't-1', plan: TenantPlan.ENTERPRISE, key: 'acme' });

    await service.triggerDowngrade('t-1', TenantPlan.STARTER);

    expect(billing.recordPlanChange).toHaveBeenCalledWith('t-1', TenantPlan.STARTER, expect.any(Date), expect.any(String));
    expect(tenantBucket.applyPlanStorageQuota).toHaveBeenCalledWith('t-1', TenantPlan.STARTER);
  });

  it('a failing plan-history write does not fail the downgrade (best-effort, the plan column already committed)', async () => {
    const { service, billing } = makeService([], { id: 't-1', plan: TenantPlan.ENTERPRISE, key: 'acme' });
    billing.recordPlanChange.mockRejectedValueOnce(new Error('db down'));

    await expect(service.triggerDowngrade('t-1', TenantPlan.STARTER)).resolves.toMatchObject({ toPlan: TenantPlan.STARTER });
  });
});
