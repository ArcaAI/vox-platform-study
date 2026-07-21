import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SysEventType, ValueType } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import { EntitlementsService } from '../entitlements.service';
import { GIB, ENTITLEMENTS_QUOTA_BLOCKED_EVENT, ENTITLEMENTS_STORAGE_WARN_EVENT } from '../entitlements.constants';

/*
 * EntitlementsService.
 *
 * The pure merge is exhaustively covered in `resolve-entitlements.test.ts`;
 * here we assert the SERVICE behaviour: DB wiring into the resolver, the
 * capability/usage composition, the kill-switch read/write, and the
 * matrix/override CRUD (incl. OCC + reversible clear).
 */

const cache = new Map<string, { id: string; version: number }>();
const values = new Map<string, unknown>();

const tenantRepository = { findById: vi.fn() };
const planEntitlementRepository = { findByPlan: vi.fn(), findAll: vi.fn(), updateWithVersion: vi.fn() };
const tenantEntitlementRepository = { findByTenant: vi.fn(), create: vi.fn(), updateWithVersion: vi.fn() };
const apiKeyRepository = { count: vi.fn() };
const tenantService = { getUsageStats: vi.fn() };
const metering = { getCurrentUsage: vi.fn().mockResolvedValue({ consultations: 0, transcriptionMinutes: 0, summaries: 0 }) };

const appSettings = {
  getFromCache: vi.fn((k: string) => cache.get(k)),
  getValueFromCache: vi.fn((k: string) => (values.has(k) ? values.get(k) : null)),
  getValueWithDefault: vi.fn((k: string, d: unknown) => (values.has(k) ? values.get(k) : d)),
  hasSetting: vi.fn((k: string) => values.has(k)),
  getAllKeys: vi.fn(() => Array.from(values.keys())),
  getCacheStats: vi.fn(),
  cacheAppSettings: vi.fn(),
  updateCacheAppSettings: vi.fn(),
  refreshCache: vi.fn().mockResolvedValue(undefined),
  stopCacheRefresh: vi.fn(),
  validateSettingValue: vi.fn(() => true),
};

const globalSettings = { update: vi.fn().mockResolvedValue({}), create: vi.fn().mockResolvedValue({}) };
const eventEmitter = { emit: vi.fn() };
const clsService = { get: vi.fn(() => undefined) };
// (concurrency) — live per-tenant socket count source.
const socketRegistry = { getTenantAggregateCount: vi.fn().mockResolvedValue(0) };

const makeService = () =>
  new EntitlementsService(
    tenantRepository as any,
    planEntitlementRepository as any,
    tenantEntitlementRepository as any,
    apiKeyRepository as any,
    tenantService as any,
    metering as any,
    appSettings as any,
    globalSettings as any,
    eventEmitter as any,
    clsService as any,
    socketRegistry as any,
  );

const usageStats = (o: Record<string, unknown> = {}) => ({
  totalUsers: 0,
  totalDepartments: 0,
  totalPromptTemplates: 0,
  totalPipelines: 0,
  storageUsedBytes: 0,
  storageQuotaBytes: null,
  transcriptionMinutes: 0,
  summaries24h: 0,
  totalConsultations: 0,
  ...o,
});

const fakePlanEntity = (o: Record<string, unknown> = {}) => ({
  id: 'pe-1',
  plan: 'STARTER',
  maxUsers: 5,
  maxDepartments: 2,
  maxPromptTemplates: 10,
  maxAsrPipelines: 1,
  maxApiKeys: 2,
  storageQuotaBytes: null as bigint | null,
  monthlyConsultations: 500,
  monthlyTranscriptionMinutes: 1000,
  monthlySummaries: 500,
  featureDnaReports: false,
  featureVoiceEnrollment: false,
  featureMonitoringAccess: false,
  modelTier: 'base',
  rateLimitTier: 'strict',
  version: 1,
  updatedBy: null,
  toObject: () => ({}),
  ...o,
});

const fakeTenantEntity = (o: Record<string, unknown> = {}) => ({
  id: 'te-1',
  tenantId: 'tenant-1',
  maxUsers: null,
  maxDepartments: null,
  maxPromptTemplates: null,
  maxAsrPipelines: null,
  maxApiKeys: null,
  storageQuotaBytes: null as bigint | null,
  monthlyConsultations: null,
  monthlyTranscriptionMinutes: null,
  monthlySummaries: null,
  featureDnaReports: null,
  featureVoiceEnrollment: null,
  featureMonitoringAccess: null,
  modelTier: null,
  rateLimitTier: null,
  rateLimitPerMinute: null,
  version: 2,
  updatedBy: null,
  toObject: () => ({}),
  ...o,
});

describe('EntitlementsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.clear();
    values.clear();
  });

  describe('kill-switch (Q9)', () => {
    it('defaults enforcement OFF when the setting is absent', () => {
      expect(makeService().isEnforcementEnabled()).toBe(false);
    });

    it('reads the DB value when present', () => {
      values.set('entitlements.enabled', true);
      expect(makeService().isEnforcementEnabled()).toBe(true);
    });

    it('creates the platform kill-switch row + refreshes the cache when uncached', async () => {
      await makeService().setEnforcementEnabled(true);

      expect(globalSettings.create).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'entitlements.enabled',
          value: 'true',
          dataType: ValueType.Boolean,
          namespace: 'entitlements',
          tenantId: '50000000-0000-0000-0000-000000000000',
        }),
      );
      expect(appSettings.refreshCache).toHaveBeenCalledTimes(1);
    });

    it('updates the seeded row by id with the cached version', async () => {
      cache.set('entitlements.enabled', { id: 'gs-ent', version: 3 });
      await makeService().setEnforcementEnabled(false);

      expect(globalSettings.update).toHaveBeenCalledWith('gs-ent', { value: 'false', expectedVersion: 3 });
      expect(globalSettings.create).not.toHaveBeenCalled();
    });
  });

  describe('resolveForTenant', () => {
    it('resolves a null-plan tenant to ungated-legacy (Q3)', async () => {
      tenantRepository.findById.mockResolvedValue({ plan: null, trialEndsAt: null });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      const resolved = await makeService().resolveForTenant('sys-tenant');

      expect(resolved.gated).toBe(false);
      expect(resolved.limits.maxUsers).toBeNull();
      expect(planEntitlementRepository.findByPlan).not.toHaveBeenCalled();
    });

    it('falls back to the seeded matrix when no DB plan row exists', async () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      const resolved = await makeService().resolveForTenant('tenant-1');

      expect(resolved.gated).toBe(true);
      expect(resolved.limits.maxUsers).toBe(5);
      expect(resolved.modelTier).toBe('base');
    });

    it('layers a per-tenant override on top of the plan default', async () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'PRO', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue({ maxUsers: 999 });

      const resolved = await makeService().resolveForTenant('tenant-1');

      expect(resolved.limits.maxUsers).toBe(999);
      expect(resolved.limits.maxDepartments).toBe(10); // inherited PRO default
    });
  });

  describe('getCapabilities', () => {
    it('composes resolved limits with live usage + flags near-limit', async () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantService.getUsageStats.mockResolvedValue(usageStats({ totalUsers: 4, storageUsedBytes: 2048 }));
      apiKeyRepository.count.mockResolvedValue(1);
      // Q5 live meters: 450/500 consultations trips near-limit.
      metering.getCurrentUsage.mockResolvedValue({ consultations: 450, transcriptionMinutes: 100, summaries: 0 });
      // (concurrency) — 3 live sessions against the STARTER cap of 5.
      socketRegistry.getTenantAggregateCount.mockResolvedValueOnce(3);

      const caps = await makeService().getCapabilities('tenant-1');

      const users = caps.quantities.find((q) => q.key === 'users')!;
      expect(users).toMatchObject({ limit: 5, used: 4, remaining: 1, unlimited: false, nearLimit: true, exceeded: false });

      // (concurrency) — live sessions vs. the concurrency cap.
      const concurrency = caps.quantities.find((q) => q.key === 'concurrentSessions')!;
      expect(concurrency).toMatchObject({ limit: 5, used: 3, remaining: 2, unlimited: false, exceeded: false });

      const storage = caps.quantities.find((q) => q.key === 'storageBytes')!;
      expect(storage).toMatchObject({ limit: 5 * GIB, used: 2048, unlimited: false });

      // Q5 — meters carry live rolling-monthly usage.
      const consultations = caps.meters.find((m) => m.key === 'monthlyConsultations')!;
      expect(consultations).toMatchObject({ limit: 500, used: 450, nearLimit: true, exceeded: false });
      expect(caps.enforcementEnabled).toBe(false);
      expect(caps.gated).toBe(true);
      expect(caps.trial.isTrial).toBe(false);
    });

    it('reports PRO limits + a live trial clock for a TRIAL tenant', async () => {
      const trialEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      tenantRepository.findById.mockResolvedValue({ plan: 'TRIAL', trialEndsAt });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantService.getUsageStats.mockResolvedValue(usageStats());
      apiKeyRepository.count.mockResolvedValue(0);

      const caps = await makeService().getCapabilities('tenant-1');

      expect(caps.quantities.find((q) => q.key === 'users')!.limit).toBe(25); // TRIAL = PRO
      expect(caps.trial.isTrial).toBe(true);
      expect(caps.trial.expired).toBe(false);
      expect(caps.trial.daysRemaining).toBe(3);
    });
  });

  describe('plan matrix CRUD', () => {
    it('lists the seeded rows', async () => {
      planEntitlementRepository.findAll.mockResolvedValue([fakePlanEntity()]);
      const rows = await makeService().listPlanEntitlements();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ plan: 'STARTER', maxUsers: 5, version: 1 });
    });

    it('rejects an unknown plan name', async () => {
      await expect(makeService().getPlanEntitlement('BOGUS')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s a known but unseeded plan', async () => {
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      await expect(makeService().getPlanEntitlement('PRO')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('applies supplied fields under OCC and broadcasts ResourceUpdated', async () => {
      const row = fakePlanEntity({ plan: 'PRO', maxUsers: 25, version: 4 });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().updatePlanEntitlement('PRO', { maxUsers: 40, expectedVersion: 4 });

      expect(row.maxUsers).toBe(40);
      expect(planEntitlementRepository.updateWithVersion).toHaveBeenCalledWith('pe-1', row, 4);
      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: 'pe-1' }));
      expect(res.maxUsers).toBe(40);
    });

    it('converts a storageQuotaBytes number into the bigint column', async () => {
      const row = fakePlanEntity({ plan: 'PRO', version: 1 });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      await makeService().updatePlanEntitlement('PRO', { storageQuotaBytes: 10 * GIB, expectedVersion: 1 });

      expect(row.storageQuotaBytes).toBe(BigInt(10 * GIB));
    });
  });

  describe('tenant override CRUD (Q1/Q7)', () => {
    it('returns null when the tenant inherits the plan (no override row)', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      expect(await makeService().getTenantEntitlement('tenant-1')).toBeNull();
    });

    it('creates the first override row and broadcasts ResourceCreated', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantRepository.findById.mockResolvedValue({ id: 'tenant-1' });
      tenantEntitlementRepository.create.mockImplementation(async (entity) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { maxUsers: 50 });

      expect(tenantEntitlementRepository.create).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({}));
      expect(res.maxUsers).toBe(50);
      expect(res.tenantId).toBe('tenant-1');
    });

    it('requires expectedVersion to update an existing override', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(fakeTenantEntity());
      await expect(makeService().upsertTenantEntitlement('tenant-1', { maxUsers: 10 })).rejects.toBeInstanceOf(BadRequestException);
      expect(tenantEntitlementRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('updates an existing override under OCC', async () => {
      const row = fakeTenantEntity({ version: 7 });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { maxUsers: 12, expectedVersion: 7 });

      expect(row.maxUsers).toBe(12);
      expect(tenantEntitlementRepository.updateWithVersion).toHaveBeenCalledWith('te-1', row, 7);
      expect(res.maxUsers).toBe(12);
    });

    it('clears an override by nulling every field (reversible, never deleted)', async () => {
      const row = fakeTenantEntity({ maxUsers: 99, rateLimitPerMinute: 300, version: 5 });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      await makeService().clearTenantEntitlement('tenant-1');

      expect(row.maxUsers).toBeNull();
      expect(row.rateLimitPerMinute).toBeNull();
      expect(tenantEntitlementRepository.updateWithVersion).toHaveBeenCalledWith('te-1', row, 5);
    });

    it('is a no-op when clearing a tenant with no override', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      await makeService().clearTenantEntitlement('tenant-1');
      expect(tenantEntitlementRepository.updateWithVersion).not.toHaveBeenCalled();
    });
  });

  describe('assertQuantityQuota (Q9 gate + Q10 block-new)', () => {
    // STARTER.maxUsers = 5 in the seeded matrix.
    const asStarter = () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
    };

    it('is a NO-OP when the kill-switch is OFF, even over the limit (Q9)', async () => {
      asStarter(); // enforcement default OFF
      await expect(makeService().assertQuantityQuota('tenant-1', 'maxUsers', 99)).resolves.toBeUndefined();
      expect(tenantRepository.findById).not.toHaveBeenCalled(); // short-circuits before resolving
    });

    it('is a NO-OP for an unlimited (null-plan / ungated) tenant (Q3)', async () => {
      values.set('entitlements.enabled', true);
      tenantRepository.findById.mockResolvedValue({ plan: null, trialEndsAt: null });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      await expect(makeService().assertQuantityQuota('sys-tenant', 'maxUsers', 10_000)).resolves.toBeUndefined();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('allows a create that stays within the limit', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      // 4 used, +1 = 5 == limit → allowed.
      await expect(makeService().assertQuantityQuota('tenant-1', 'maxUsers', 4)).resolves.toBeUndefined();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('throws QuotaExceededException + emits a block event when over the limit', async () => {
      values.set('entitlements.enabled', true);
      asStarter();

      await expect(makeService().assertQuantityQuota('tenant-1', 'maxUsers', 5)).rejects.toBeInstanceOf(QuotaExceededException);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ENTITLEMENTS_QUOTA_BLOCKED_EVENT,
        expect.objectContaining({ tenantId: 'tenant-1', capability: 'maxUsers', limit: 5, used: 5 }),
      );
    });

    it('carries structured metadata for the API to render', async () => {
      values.set('entitlements.enabled', true);
      asStarter();

      await makeService()
        .assertQuantityQuota('tenant-1', 'maxUsers', 8)
        .then(() => expect.unreachable('should have thrown'))
        .catch((err: QuotaExceededException) => {
          expect(err).toBeInstanceOf(QuotaExceededException);
          expect(err.metadata).toMatchObject({ capability: 'maxUsers', limit: 5, used: 8, requested: 1, tenantId: 'tenant-1' });
        });
    });
  });

  describe('assertMeterQuota (Q5 meters, → 429)', () => {
    // STARTER.monthlyConsultations = 500 in the seeded matrix.
    const asStarter = () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
    };

    it('is a NO-OP when the kill-switch is OFF — never reads the live meter (Q9)', async () => {
      asStarter(); // enforcement default OFF
      await expect(makeService().assertMeterQuota('tenant-1', 'monthlyConsultations')).resolves.toBeUndefined();
      expect(metering.getCurrentUsage).not.toHaveBeenCalled();
    });

    it('allows a submit that stays within the monthly cap', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      metering.getCurrentUsage.mockResolvedValueOnce({ consultations: 100, transcriptionMinutes: 0, summaries: 0 });
      await expect(makeService().assertMeterQuota('tenant-1', 'monthlyConsultations')).resolves.toBeUndefined();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('throws QuotaExceededException + emits a block event once at/over the monthly cap', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      metering.getCurrentUsage.mockResolvedValueOnce({ consultations: 500, transcriptionMinutes: 0, summaries: 0 });

      await expect(makeService().assertMeterQuota('tenant-1', 'monthlyConsultations')).rejects.toBeInstanceOf(QuotaExceededException);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ENTITLEMENTS_QUOTA_BLOCKED_EVENT,
        expect.objectContaining({ capability: 'monthlyConsultations', limit: 500, used: 500 }),
      );
    });
  });

  describe('assertConcurrencyQuota (TASK-392 concurrency, hard-block → 429)', () => {
    // STARTER.maxConcurrentSessions = 5 in the seeded matrix.
    const asStarter = () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
    };

    it('is a NO-OP when the kill-switch is OFF — never reads the registry (Q9)', async () => {
      asStarter(); // enforcement default OFF
      await expect(makeService().assertConcurrencyQuota('tenant-1')).resolves.toBeUndefined();
      expect(socketRegistry.getTenantAggregateCount).not.toHaveBeenCalled();
      expect(tenantRepository.findById).not.toHaveBeenCalled();
    });

    it('is a NO-OP for an unlimited (null-plan / ungated) tenant (Q3)', async () => {
      values.set('entitlements.enabled', true);
      tenantRepository.findById.mockResolvedValue({ plan: null, trialEndsAt: null });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      await expect(makeService().assertConcurrencyQuota('sys-tenant')).resolves.toBeUndefined();
      expect(socketRegistry.getTenantAggregateCount).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('allows a new session UNDER the concurrency cap', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      socketRegistry.getTenantAggregateCount.mockResolvedValueOnce(4); // 4 + 1 = 5 == cap → allowed
      await expect(makeService().assertConcurrencyQuota('tenant-1')).resolves.toBeUndefined();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('HARD-BLOCKS (throws + emits) a new session AT/OVER the cap', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      socketRegistry.getTenantAggregateCount.mockResolvedValueOnce(5); // 5 + 1 > 5 → block

      await expect(makeService().assertConcurrencyQuota('tenant-1')).rejects.toBeInstanceOf(QuotaExceededException);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ENTITLEMENTS_QUOTA_BLOCKED_EVENT,
        expect.objectContaining({ tenantId: 'tenant-1', capability: 'maxConcurrentSessions', limit: 5, used: 5 }),
      );
    });

    it('respects a per-tenant concurrency override', async () => {
      values.set('entitlements.enabled', true);
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue({ maxConcurrentSessions: 10 });
      socketRegistry.getTenantAggregateCount.mockResolvedValueOnce(7); // 7 + 1 = 8 <= 10 → allowed

      await expect(makeService().assertConcurrencyQuota('tenant-1')).resolves.toBeUndefined();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('fails OPEN (no block) when the registry read throws (Redis blip)', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      socketRegistry.getTenantAggregateCount.mockRejectedValueOnce(new Error('redis down'));

      await expect(makeService().assertConcurrencyQuota('tenant-1')).resolves.toBeUndefined();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('evaluateStorageSoftWarn (Q6, never blocks)', () => {
    // STARTER.storageQuotaBytes = 5 GiB in the seeded matrix.
    const asStarter = () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
    };

    it('is a NO-OP (warn:false) when the kill-switch is OFF (Q9)', async () => {
      asStarter();
      const result = await makeService().evaluateStorageSoftWarn('tenant-1', 10 * GIB);
      expect(result.warn).toBe(false);
      expect(tenantService.getUsageStats).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('is a NO-OP for an unlimited (null-plan / ungated) tenant (Q3)', async () => {
      values.set('entitlements.enabled', true);
      tenantRepository.findById.mockResolvedValue({ plan: null, trialEndsAt: null });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      const result = await makeService().evaluateStorageSoftWarn('sys-tenant', 10 * GIB);
      expect(result.warn).toBe(false);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does NOT warn when the projected usage stays within quota', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      tenantService.getUsageStats.mockResolvedValue(usageStats({ storageUsedBytes: 1 * GIB }));
      const result = await makeService().evaluateStorageSoftWarn('tenant-1', 1 * GIB);
      expect(result).toMatchObject({ warn: false, quotaBytes: 5 * GIB, usedBytes: 1 * GIB });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('WARNS (event emitted) but never throws when the upload crosses quota', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      tenantService.getUsageStats.mockResolvedValue(usageStats({ storageUsedBytes: 5 * GIB }));
      const result = await makeService().evaluateStorageSoftWarn('tenant-1', 1024);
      expect(result.warn).toBe(true);
      expect(result.projectedBytes).toBe(5 * GIB + 1024);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ENTITLEMENTS_STORAGE_WARN_EVENT,
        expect.objectContaining({ tenantId: 'tenant-1', quotaBytes: 5 * GIB, projectedBytes: 5 * GIB + 1024 }),
      );
    });
  });
});
