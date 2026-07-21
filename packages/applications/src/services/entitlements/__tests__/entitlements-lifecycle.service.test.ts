/**
 * (Q4 trial-expiry + Q10 downgrade soft-disable) — lifecycle service.
 *
 * Behaviour under test (not the mock plumbing):
 *   - expireTrials: downgrades ONLY expired TRIAL tenants to STARTER, PLAN-ONLY
 *     (never touches resourceStatus), skips the system tenant + not-yet-expired
 *     trials, and emits a per-tenant SysEvent + trial-expired event.
 *   - triggerDowngrade: always relabels the plan; soft-disables NEWEST-first
 *     overflow rows ONLY when the kill-switch is ON (reversible DISABLED flip,
 *     never a delete); rejects the system tenant; grandfathers within-limit rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceStatusType, SysEventType, TenantPlan } from '@arcaai/domains';
import { EntitlementsLifecycleService } from '../entitlements-lifecycle.service';
import { ENTITLEMENTS_DOWNGRADE_APPLIED_EVENT, ENTITLEMENTS_TRIAL_EXPIRED_EVENT } from '../entitlements-lifecycle.constants';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const FIXED_NOW = new Date('2026-03-17T09:41:23.456Z');
const PAST = new Date('2026-03-01T00:00:00.000Z');
const FUTURE = new Date('2026-04-01T00:00:00.000Z');

function makeCls() {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn((k: string, v: unknown) => store.set(k, v)),
    get: vi.fn((k: string) => store.get(k)),
  };
}

function makeBaseClient(overrides: Record<string, unknown> = {}) {
  const model = (rows: Array<{ id: string; createdAt: Date }> = []) => ({
    findMany: vi.fn().mockResolvedValue(rows),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  });
  return {
    tenant: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    department: model(),
    promptTemplate: model(),
    asrPipeline: model(),
    apiKey: model(),
    ...overrides,
  };
}

function makeService(baseClient: ReturnType<typeof makeBaseClient>, opts: { enforcement?: boolean; limits?: Record<string, number | null> } = {}) {
  const entitlements = {
    isEnforcementEnabled: vi.fn().mockReturnValue(opts.enforcement ?? false),
    resolveForTenant: vi.fn().mockResolvedValue({
      limits: {
        maxUsers: 5,
        maxDepartments: 2,
        maxPromptTemplates: 10,
        maxAsrPipelines: 1,
        maxApiKeys: 2,
        storageQuotaBytes: null,
        monthlyConsultations: null,
        monthlyTranscriptionMinutes: null,
        monthlySummaries: null,
        ...(opts.limits ?? {}),
      },
    }),
  } as never;
  const appSettings = { getValueWithDefault: vi.fn((_k: string, fallback: unknown) => fallback) } as never;
  const schedulerRegistry = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;
  const databaseService = { baseClient } as never;
  const eventEmitter = { emit: vi.fn() } as never;
  const cls = makeCls() as never;
  const service = new EntitlementsLifecycleService(databaseService, entitlements, appSettings, schedulerRegistry, eventEmitter, cls);
  return { service, eventEmitter, cls, entitlements };
}

describe('EntitlementsLifecycleService.expireTrials (TASK-392 Q4)', () => {
  it('downgrades ONLY expired TRIAL tenants to STARTER, plan-only', async () => {
    const baseClient = makeBaseClient({
      tenant: {
        findMany: vi.fn().mockResolvedValue([
          { id: 't-expired', plan: TenantPlan.TRIAL, trialEndsAt: PAST, key: 'acme' },
          { id: 't-active', plan: TenantPlan.TRIAL, trialEndsAt: FUTURE, key: 'globex' },
        ]),
        update: vi.fn().mockResolvedValue({}),
      },
    });
    const { service, eventEmitter } = makeService(baseClient);

    const report = await service.expireTrials(FIXED_NOW);

    expect(report).toMatchObject({ examined: 2, downgraded: 1, tenantIds: ['t-expired'] });
    expect(baseClient.tenant.update).toHaveBeenCalledTimes(1);
    const call = (baseClient.tenant.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({ where: { id: 't-expired' }, data: { plan: TenantPlan.STARTER } });
    // PLAN-ONLY — resourceStatus must NOT be part of the update (proposal §4).
    expect(call.data).not.toHaveProperty('resourceStatus');
    expect(eventEmitter.emit).toHaveBeenCalledWith(ENTITLEMENTS_TRIAL_EXPIRED_EVENT, expect.objectContaining({ tenantId: 't-expired' }));
  });

  it('skips the reserved system tenant even if its trial looks expired', async () => {
    const baseClient = makeBaseClient({
      tenant: {
        findMany: vi.fn().mockResolvedValue([{ id: SYSTEM_TENANT_ID, plan: TenantPlan.TRIAL, trialEndsAt: PAST, key: 'system' }]),
        update: vi.fn().mockResolvedValue({}),
      },
    });
    const { service } = makeService(baseClient);

    const report = await service.expireTrials(FIXED_NOW);

    expect(report.downgraded).toBe(0);
    expect(baseClient.tenant.update).not.toHaveBeenCalled();
  });

  it('emits a per-tenant ResourceUpdated SysEvent attributed to the target tenant', async () => {
    const baseClient = makeBaseClient({
      tenant: {
        findMany: vi.fn().mockResolvedValue([{ id: 't-expired', plan: TenantPlan.TRIAL, trialEndsAt: PAST, key: 'acme' }]),
        update: vi.fn().mockResolvedValue({}),
      },
    });
    const { service, eventEmitter } = makeService(baseClient);

    await service.expireTrials(FIXED_NOW);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ tenantId: 't-expired', resourceId: 't-expired' }),
    );
  });
});

describe('EntitlementsLifecycleService.triggerDowngrade (TASK-392 Q10)', () => {
  it('rejects the reserved system tenant', async () => {
    const baseClient = makeBaseClient();
    const { service } = makeService(baseClient);

    await expect(service.triggerDowngrade(SYSTEM_TENANT_ID, TenantPlan.STARTER)).rejects.toThrow();
    expect(baseClient.tenant.update).not.toHaveBeenCalled();
  });

  it('relabels the plan but does NOT soft-disable when the kill-switch is OFF (Q9)', async () => {
    const baseClient = makeBaseClient({
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: 't-1', plan: TenantPlan.ENTERPRISE, key: 'acme' }),
        update: vi.fn().mockResolvedValue({}),
      },
      department: { findMany: vi.fn().mockResolvedValue([{ id: 'd1', createdAt: PAST }, { id: 'd2', createdAt: PAST }, { id: 'd3', createdAt: FUTURE }]), updateMany: vi.fn() },
    });
    const { service } = makeService(baseClient, { enforcement: false });

    const report = await service.triggerDowngrade('t-1', TenantPlan.STARTER);

    expect(baseClient.tenant.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't-1' }, data: expect.objectContaining({ plan: TenantPlan.STARTER }) }));
    expect(report.totalDisabled).toBe(0);
    expect(baseClient.department.updateMany).not.toHaveBeenCalled();
  });

  it('soft-disables the NEWEST overflow rows (reversible DISABLED flip) when enforcement is ON', async () => {
    const baseClient = makeBaseClient({
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: 't-1', plan: TenantPlan.ENTERPRISE, key: 'acme' }),
        update: vi.fn().mockResolvedValue({}),
      },
      // limit 2 → keep oldest d1,d2; disable newest d3.
      department: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'd1', createdAt: new Date('2026-01-01') },
          { id: 'd2', createdAt: new Date('2026-01-02') },
          { id: 'd3', createdAt: new Date('2026-01-03') },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      // limit 2 → disable newest key-3.
      apiKey: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'k1', createdAt: new Date('2026-01-01') },
          { id: 'k2', createdAt: new Date('2026-01-02') },
          { id: 'k3', createdAt: new Date('2026-01-03') },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    const { service, eventEmitter } = makeService(baseClient, { enforcement: true });

    const report = await service.triggerDowngrade('t-1', TenantPlan.STARTER);

    // Department overflow disabled.
    expect(baseClient.department.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['d3'] } },
        data: expect.objectContaining({ resourceStatus: ResourceStatusType.DISABLED }),
      }),
    );
    // Never a delete — status flip only (reversible).
    expect(baseClient.department.updateMany.mock.calls[0][0].data).not.toHaveProperty('deletedAt');
    // API-key overflow disabled.
    expect(baseClient.apiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['k3'] } }, data: expect.objectContaining({ resourceStatus: ResourceStatusType.DISABLED }) }),
    );

    expect(report.totalDisabled).toBe(2);
    const deptGroup = report.disabled.find((g) => g.capability === 'maxDepartments');
    expect(deptGroup).toMatchObject({ disabledCount: 1, ids: ['d3'] });
    expect(eventEmitter.emit).toHaveBeenCalledWith(ENTITLEMENTS_DOWNGRADE_APPLIED_EVENT, expect.objectContaining({ tenantId: 't-1', totalDisabled: 2 }));
  });

  it('grandfathers within-limit resources (no disable) under enforcement', async () => {
    const baseClient = makeBaseClient({
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: 't-1', plan: TenantPlan.PRO, key: 'acme' }),
        update: vi.fn().mockResolvedValue({}),
      },
      // 2 departments, limit 2 → nothing to disable.
      department: {
        findMany: vi.fn().mockResolvedValue([{ id: 'd1', createdAt: PAST }, { id: 'd2', createdAt: FUTURE }]),
        updateMany: vi.fn(),
      },
    });
    const { service } = makeService(baseClient, { enforcement: true });

    const report = await service.triggerDowngrade('t-1', TenantPlan.STARTER);

    expect(baseClient.department.updateMany).not.toHaveBeenCalled();
    expect(report.totalDisabled).toBe(0);
  });
});
