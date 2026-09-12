import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { SysEventType, ValueType } from '@arcaai/domains';
import { QuotaExceededException } from '@arcaai/exceptions';
import { EntitlementsService } from '../entitlements.service';
import { GIB, ENTITLEMENTS_QUOTA_BLOCKED_EVENT, ENTITLEMENTS_STORAGE_WARN_EVENT, ENTITLEMENTS_TENANT_ID } from '../entitlements.constants';

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
const metering = {
  getCurrentUsage: vi.fn().mockResolvedValue({
    consultations: 0,
    transcriptionMinutes: 0,
    summaries: 0,
    sttSessionSeconds: 0,
    llmTokens: 0,
    ttsCharacters: 0,
    nlpTextUnits: 0,
    guardrailCalls: 0,
    embeddingTokens: 0,
  }),
};

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
// Fail-open observability: the skipped-meter-check counter. `createCounter` is
// idempotent in the real `MetricsService`, so one shared fake counter is faithful.
const skipCounter = { inc: vi.fn() };
const metricsService = { createCounter: vi.fn(() => skipCounter) };

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
    metricsService as any,
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
  monthlySttSessionSeconds: null as bigint | null,
  monthlyLlmTokens: null as bigint | null,
  monthlyTtsCharacters: null as bigint | null,
  monthlyNlpTextUnits: null as bigint | null,
  monthlyEmbeddingTokens: null as bigint | null,
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
  monthlySttSessionSeconds: null as bigint | null,
  monthlyLlmTokens: null as bigint | null,
  monthlyTtsCharacters: null as bigint | null,
  monthlyNlpTextUnits: null as bigint | null,
  monthlyEmbeddingTokens: null as bigint | null,
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

  describe('kill-switch', () => {
    it('defaults enforcement ON when the setting is absent (OD-6)', () => {
      // Was OFF, so an unseeded database silently granted every tenant
      // unlimited quota. The seeded row still decides a live environment; this
      // default only covers the "row is missing" case.
      expect(makeService().isEnforcementEnabled()).toBe(true);
    });

    it('still reads an explicit OFF from the DB over the ON default', () => {
      values.set('entitlements.enabled', false);
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
          tenantId: ENTITLEMENTS_TENANT_ID,
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
    it('resolves a plan-less RESERVED tenant to ungated-legacy (OD-5)', async () => {
      tenantRepository.findById.mockResolvedValue({ plan: null, trialEndsAt: null });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      const resolved = await makeService().resolveForTenant(ENTITLEMENTS_TENANT_ID);

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

    /*
     * (owner decision, 2026-08-20): the ArcaAI day-1 tenant is
     * seeded with `plan: 'ENTERPRISE'` (packages/database seed/05-tenant.ts,
     * pinned by `tenant-plan-seed.test.ts`). This proves the OTHER half of
     * that decision — that the entitlement path actually resolves a REAL,
     * gated ENTERPRISE quota set for a tenant carrying that plan, rather than
     * silently falling through to `UNGATED_ENTITLEMENTS` (the null-plan Q3
     * default every un-planned seeded tenant — SYSTEM, Global — still gets).
*/
    it('resolves an ENTERPRISE-plan tenant (as seeded for ArcaAI) to real gated quotas, never ungated-legacy', async () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'ENTERPRISE', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      const resolved = await makeService().resolveForTenant('arcaai-tenant');

      expect(resolved.gated).toBe(true);
      expect(resolved.plan).toBe('ENTERPRISE');
      // Structural caps are finite on ENTERPRISE (RATIFIED 2026-08-08) —
      // an ungated-legacy resolution would have every one of these `null`.
      expect(resolved.limits.maxUsers).toBe(100);
      expect(resolved.limits.maxDepartments).toBe(40);
      expect(resolved.limits.maxApiKeys).toBe(50);
      // Usage meters are unlimited on ENTERPRISE by design (negotiated), so
      // this alone would NOT distinguish it from ungated-legacy — the
      // structural caps above are the load-bearing assertion.
      expect(resolved.limits.monthlyConsultations).toBeNull();
    });
  });

  /*
   * `isFeatureEnabled`, the ENFORCING read of a boolean entitlement. It was
   * the FIRST such read: the three display-only booleans that preceded it were
   * consulted by nothing but `getCapabilities` and the console, and TASK-883
   * retired them.
   *
   * Non-throwing by design: the caller (`AiProviderConnectionService.cascadeRows`)
   * uses it to SHAPE a credential cascade, at a point where nobody yet knows
   * which provider will be selected. Throwing there would 403 a tenant that was
   * about to use a self-hosted provider and never needed the platform key.
   */
  describe('isFeatureEnabled', () => {
    const arrangeTenant = (override: Record<string, unknown> | null) => {
      tenantRepository.findById.mockResolvedValue({ plan: 'PRO', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(override);
    };

    // 28
    it('returns the resolved boolean and never throws, for either value', async () => {
      values.set('entitlements.enabled', true);

      arrangeTenant({ featurePlatformDefaultCredential: true });
      await expect(makeService().isFeatureEnabled('tenant-1', 'platformDefaultCredential')).resolves.toBe(true);

      arrangeTenant({ featurePlatformDefaultCredential: false });
      await expect(makeService().isFeatureEnabled('tenant-1', 'platformDefaultCredential')).resolves.toBe(false);

      // …and the seeded plan default (no override row at all) is `false`.
      arrangeTenant(null);
      await expect(makeService().isFeatureEnabled('tenant-1', 'platformDefaultCredential')).resolves.toBe(false);
    });

    it('reads the other feature booleans through the same path', async () => {
      values.set('entitlements.enabled', true);
      arrangeTenant(null);
      // PRO seeds paletteStt=true, agenticLoop=true; STARTER seeds agenticLoop=false.
      await expect(makeService().isFeatureEnabled('tenant-1', 'paletteStt')).resolves.toBe(true);
      await expect(makeService().isFeatureEnabled('tenant-1', 'agenticLoop')).resolves.toBe(true);
    });

    /*
     * 29 — OD-6 (DECIDED 2026-08-09): the gate HONOURS the global kill switch.
     *
     * `isFeatureEnabled` returns early exactly like the four existing
     * enforcement methods (`assertQuantityQuota:215`, `assertMeterQuota`,
     * `assertConcurrencyQuota`, `evaluateStorageSoftWarn`), all of which
     * return WITHOUT ENFORCING when `entitlements.enabled` is off. For a
     * boolean read, "do not enforce" means `true` — the feature is not gated.
     *
     * The consequence is deliberate and must be stated, not discovered: with
     * the switch OFF the platform-default gate is INERT and every tenant may
     * reach the SYSTEM credential tier. The owner flips `entitlements.enabled`
     * on separately; this test is what documents the two states, and it must
     * fail if anyone later changes the behaviour in either direction.
     */
    it('honours the global kill switch: returns true (ungated) when entitlements.enabled is OFF (OD-6)', async () => {
      // Switch OFF — the tenant is explicitly DENIED in its override row, and
      // still reads `true`, because enforcement as a whole is off.
      values.set('entitlements.enabled', false);
      arrangeTenant({ featurePlatformDefaultCredential: false });
      await expect(makeService().isFeatureEnabled('tenant-1', 'platformDefaultCredential')).resolves.toBe(true);
      // Not even resolved — the early return happens before any DB read.
      expect(tenantRepository.findById).not.toHaveBeenCalled();

      // Switch ON — the resolved value is authoritative again.
      values.set('entitlements.enabled', true);
      arrangeTenant({ featurePlatformDefaultCredential: false });
      await expect(makeService().isFeatureEnabled('tenant-1', 'platformDefaultCredential')).resolves.toBe(false);
      expect(tenantRepository.findById).toHaveBeenCalled();
    });
  });

  describe('getCapabilities', () => {
    it('composes resolved limits with live usage + flags near-limit', async () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantService.getUsageStats.mockResolvedValue(usageStats({ totalUsers: 4, storageUsedBytes: 2048 }));
      apiKeyRepository.count.mockResolvedValue(1);
      // Q5 live meters: 45/50 consultations (90%) trips near-limit.
      metering.getCurrentUsage.mockResolvedValue({ consultations: 45, transcriptionMinutes: 100, summaries: 0 });
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
      expect(consultations).toMatchObject({ limit: 50, used: 45, nearLimit: true, exceeded: false });
      expect(caps.enforcementEnabled).toBe(true);
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

    it('Exposes the six new unit meters (allowance ceiling + live usage) alongside M1–M3', async () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'PRO', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue({ monthlyLlmTokens: 1_000_000 });
      tenantService.getUsageStats.mockResolvedValue(usageStats());
      apiKeyRepository.count.mockResolvedValue(0);
      metering.getCurrentUsage.mockResolvedValue({
        consultations: 0,
        transcriptionMinutes: 0,
        summaries: 0,
        sttSessionSeconds: 3_600,
        llmTokens: 900_000,
        ttsCharacters: 5_000,
        nlpTextUnits: 40,
        guardrailCalls: 12,
        embeddingTokens: 100,
      });

      const caps = await makeService().getCapabilities('tenant-1');

      const llmTokens = caps.meters.find((m) => m.key === 'monthlyLlmTokens')!;
      expect(llmTokens).toMatchObject({ limit: 1_000_000, used: 900_000, nearLimit: true, exceeded: false });

      // The other four fall through to the seeded PRO ceilings.
      const sttSeconds = caps.meters.find((m) => m.key === 'monthlySttSessionSeconds')!;
      expect(sttSeconds).toMatchObject({ limit: 660_000, used: 3_600, unlimited: false, exceeded: false });

      const ttsChars = caps.meters.find((m) => m.key === 'monthlyTtsCharacters')!;
      expect(ttsChars).toMatchObject({ limit: 1_000_000, used: 5_000, unlimited: false, exceeded: false });

      const nlpUnits = caps.meters.find((m) => m.key === 'monthlyNlpTextUnits')!;
      expect(nlpUnits).toMatchObject({ limit: 15_000, used: 40, unlimited: false, exceeded: false });

      const embeddingTokens = caps.meters.find((m) => m.key === 'monthlyEmbeddingTokens')!;
      expect(embeddingTokens).toMatchObject({ limit: 750_000, used: 100, unlimited: false, exceeded: false });

      // GUARDRAIL_CALLS is informational-only — surfaced for visibility, but
      // there is no allowance column so it is ALWAYS `unlimited: true` and can
      // never appear as `exceeded`.
      const guardrailCalls = caps.meters.find((m) => m.key === 'guardrailCalls')!;
      expect(guardrailCalls).toMatchObject({ limit: null, used: 12, unlimited: true, exceeded: false });
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

    it('Converts a new allowance ceiling number into its bigint column and echoes it in the response', async () => {
      const row = fakePlanEntity({ plan: 'PRO', version: 1 });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().updatePlanEntitlement('PRO', {
        monthlyLlmTokens: 2_000_000,
        monthlyTtsCharacters: 500_000,
        expectedVersion: 1,
      });

      expect(row.monthlyLlmTokens).toBe(BigInt(2_000_000));
      expect(row.monthlyTtsCharacters).toBe(BigInt(500_000));
      expect(res.monthlyLlmTokens).toBe(2_000_000);
      expect(res.monthlyTtsCharacters).toBe(500_000);
    });

    /*
     * TASK-958 D-8 — the connection ceiling must survive the WHOLE round trip.
     *
     * Its siblings `maxWorkflowDefinitions` and `monthlyWorkflowInvocations`
     * had exactly that gap: the request DTO accepted them and the service
     * wrote them, but neither response mapper read them back, so a super admin
     * set a value, reloaded, and saw nothing. Closed as a TASK-958 follow-up
     * and pinned by the round-trip tests below.
     */
    it('writes AND echoes the AI-provider-connection ceiling', async () => {
      const row = fakePlanEntity({ plan: 'PRO', version: 1 });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().updatePlanEntitlement('PRO', { maxAiProviderConnections: 2, expectedVersion: 1 });

      expect(row.maxAiProviderConnections).toBe(2);
      expect(res.maxAiProviderConnections).toBe(2);
    });

    it('clears the connection ceiling back to unbounded on an explicit null', async () => {
      const row = fakePlanEntity({ plan: 'PRO', version: 1, maxAiProviderConnections: 2 });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().updatePlanEntitlement('PRO', { maxAiProviderConnections: null, expectedVersion: 1 });

      expect(row.maxAiProviderConnections).toBeNull();
      expect(res.maxAiProviderConnections).toBeNull();
    });

    it('writes AND echoes the published-workflow-definition ceiling', async () => {
      const row = fakePlanEntity({ plan: 'PRO', version: 1 });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().updatePlanEntitlement('PRO', { maxWorkflowDefinitions: 7, expectedVersion: 1 });

      expect(row.maxWorkflowDefinitions).toBe(7);
      expect(res.maxWorkflowDefinitions).toBe(7);
    });

    it('writes AND echoes the monthly workflow-invocation allowance', async () => {
      const row = fakePlanEntity({ plan: 'PRO', version: 1 });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().updatePlanEntitlement('PRO', { monthlyWorkflowInvocations: 5_000, expectedVersion: 1 });

      expect(row.monthlyWorkflowInvocations).toBe(5_000);
      expect(res.monthlyWorkflowInvocations).toBe(5_000);
    });

    it('clears both workflow ceilings back to unlimited on an explicit null', async () => {
      const row = fakePlanEntity({ plan: 'PRO', version: 1, maxWorkflowDefinitions: 7, monthlyWorkflowInvocations: 5_000 });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().updatePlanEntitlement('PRO', {
        maxWorkflowDefinitions: null,
        monthlyWorkflowInvocations: null,
        expectedVersion: 1,
      });

      expect(row.maxWorkflowDefinitions).toBeNull();
      expect(row.monthlyWorkflowInvocations).toBeNull();
      expect(res.maxWorkflowDefinitions).toBeNull();
      expect(res.monthlyWorkflowInvocations).toBeNull();
    });

    it('A null allowance ceiling clears it to unlimited', async () => {
      const row = fakePlanEntity({ plan: 'PRO', version: 1, monthlyLlmTokens: BigInt(2_000_000) });
      planEntitlementRepository.findByPlan.mockResolvedValue(row);
      planEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().updatePlanEntitlement('PRO', { monthlyLlmTokens: null, expectedVersion: 1 });

      expect(row.monthlyLlmTokens).toBeNull();
      expect(res.monthlyLlmTokens).toBeNull();
    });
  });

  describe('tenant override CRUD', () => {
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

    it('Creates an override with a negotiated allowance ceiling', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantRepository.findById.mockResolvedValue({ id: 'tenant-1' });
      tenantEntitlementRepository.create.mockImplementation(async (entity) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { monthlyLlmTokens: 50_000_000 });

      const created = tenantEntitlementRepository.create.mock.calls[0][0];
      expect(created.monthlyLlmTokens).toBe(BigInt(50_000_000));
      expect(res.monthlyLlmTokens).toBe(50_000_000);
    });

    it('Updates an existing override allowance under OCC', async () => {
      const row = fakeTenantEntity({ version: 3 });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { monthlySttSessionSeconds: 100_000, expectedVersion: 3 });

      expect(row.monthlySttSessionSeconds).toBe(BigInt(100_000));
      expect(res.monthlySttSessionSeconds).toBe(100_000);
    });

    it('clears an override by nulling every field (reversible, never deleted)', async () => {
      const row = fakeTenantEntity({ maxUsers: 99, rateLimitPerMinute: 300, monthlyLlmTokens: BigInt(1_000_000), maxAiProviderConnections: 2, version: 5 });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      await makeService().clearTenantEntitlement('tenant-1');

      expect(row.maxUsers).toBeNull();
      expect(row.rateLimitPerMinute).toBeNull();
      // The new allowance overrides are cleared exactly like the
      // pre-existing ones (reversible, never deleted).
      expect(row.monthlySttSessionSeconds).toBeNull();
      expect(row.monthlyLlmTokens).toBeNull();
      expect(row.monthlyTtsCharacters).toBeNull();
      expect(row.monthlyNlpTextUnits).toBeNull();
      expect(row.monthlyEmbeddingTokens).toBeNull();
      // TASK-958 — the connection ceiling is cleared with the rest.
      expect(row.maxAiProviderConnections).toBeNull();
      expect(tenantEntitlementRepository.updateWithVersion).toHaveBeenCalledWith('te-1', row, 5);
    });

    it('writes AND echoes the per-tenant connection-ceiling override', async () => {
      const row = fakeTenantEntity({ version: 2 });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { maxAiProviderConnections: 1, expectedVersion: 2 });

      expect(row.maxAiProviderConnections).toBe(1);
      expect(res.maxAiProviderConnections).toBe(1);
    });

    it('carries the connection-ceiling override onto the FIRST override row', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantRepository.findById.mockResolvedValue({ id: 'tenant-1' });
      tenantEntitlementRepository.create.mockImplementation(async (entity) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { maxAiProviderConnections: 3 });

      expect(res.maxAiProviderConnections).toBe(3);
    });

    it('writes AND echoes the per-tenant workflow overrides', async () => {
      const row = fakeTenantEntity({ version: 2 });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(row);
      tenantEntitlementRepository.updateWithVersion.mockImplementation(async (_id, entity) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', {
        maxWorkflowDefinitions: 4,
        monthlyWorkflowInvocations: 900,
        expectedVersion: 2,
      });

      expect(row.maxWorkflowDefinitions).toBe(4);
      expect(row.monthlyWorkflowInvocations).toBe(900);
      expect(res.maxWorkflowDefinitions).toBe(4);
      expect(res.monthlyWorkflowInvocations).toBe(900);
    });

    it('carries the workflow overrides onto the FIRST override row', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      tenantRepository.findById.mockResolvedValue({ id: 'tenant-1' });
      tenantEntitlementRepository.create.mockImplementation(async (entity) => entity);

      const res = await makeService().upsertTenantEntitlement('tenant-1', { maxWorkflowDefinitions: 4, monthlyWorkflowInvocations: 900 });

      expect(res.maxWorkflowDefinitions).toBe(4);
      expect(res.monthlyWorkflowInvocations).toBe(900);
    });

    it('is a no-op when clearing a tenant with no override', async () => {
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      await makeService().clearTenantEntitlement('tenant-1');
      expect(tenantEntitlementRepository.updateWithVersion).not.toHaveBeenCalled();
    });
  });

  describe('assertQuantityQuota (gate + block-new)', () => {
    // STARTER.maxUsers = 5 in the seeded matrix.
    const asStarter = () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
    };

    it('is a NO-OP when the kill-switch is OFF, even over the limit', async () => {
      values.set('entitlements.enabled', false);
      asStarter(); // enforcement default OFF
      await expect(makeService().assertQuantityQuota('tenant-1', 'maxUsers', 99)).resolves.toBeUndefined();
      expect(tenantRepository.findById).not.toHaveBeenCalled(); // short-circuits before resolving
    });

    it('is a NO-OP for an unlimited (reserved, plan-less → ungated) tenant', async () => {
      values.set('entitlements.enabled', true);
      tenantRepository.findById.mockResolvedValue({ plan: null, trialEndsAt: null });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      await expect(makeService().assertQuantityQuota(ENTITLEMENTS_TENANT_ID, 'maxUsers', 10_000)).resolves.toBeUndefined();
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

    it('Enriches the blocked-event payload with the requesting user when CLS carries one (audit-quality authorship)', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      clsService.get.mockImplementationOnce((key: string) => (key === 'user' ? { id: 'user-42' } : undefined));

      await expect(makeService().assertQuantityQuota('tenant-1', 'maxUsers', 5)).rejects.toBeInstanceOf(QuotaExceededException);

      expect(eventEmitter.emit).toHaveBeenCalledWith(ENTITLEMENTS_QUOTA_BLOCKED_EVENT, expect.objectContaining({ responsibleEntityId: 'user-42' }));
    });

    it('The blocked-event payload omits an author when CLS carries no user (background/system caller)', async () => {
      values.set('entitlements.enabled', true);
      asStarter(); // clsService.get default returns undefined for every key

      await expect(makeService().assertQuantityQuota('tenant-1', 'maxUsers', 5)).rejects.toBeInstanceOf(QuotaExceededException);

      const call = eventEmitter.emit.mock.calls.find((c) => c[0] === ENTITLEMENTS_QUOTA_BLOCKED_EVENT)!;
      expect(call[1].responsibleEntityId).toBeUndefined();
    });
  });

  describe('assertMeterQuota (meters, → 429)', () => {
    // STARTER.monthlyConsultations = 50 in the seeded matrix.
    const asStarter = () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
    };

    it('is a NO-OP when the kill-switch is OFF — never reads the live meter', async () => {
      values.set('entitlements.enabled', false);
      asStarter(); // enforcement default OFF
      await expect(makeService().assertMeterQuota('tenant-1', 'monthlyConsultations')).resolves.toBeUndefined();
      expect(metering.getCurrentUsage).not.toHaveBeenCalled();
    });

    it('allows a submit that stays within the monthly cap', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      metering.getCurrentUsage.mockResolvedValueOnce({ consultations: 10, transcriptionMinutes: 0, summaries: 0 });
      await expect(makeService().assertMeterQuota('tenant-1', 'monthlyConsultations')).resolves.toBeUndefined();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('throws QuotaExceededException + emits a block event once at/over the monthly cap', async () => {
      values.set('entitlements.enabled', true);
      asStarter();
      metering.getCurrentUsage.mockResolvedValueOnce({ consultations: 50, transcriptionMinutes: 0, summaries: 0 });

      await expect(makeService().assertMeterQuota('tenant-1', 'monthlyConsultations')).rejects.toBeInstanceOf(QuotaExceededException);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        ENTITLEMENTS_QUOTA_BLOCKED_EVENT,
        expect.objectContaining({ capability: 'monthlyConsultations', limit: 50, used: 50 }),
      );
    });

    /*
     * Metering must never take down the clinical path.
     *
     * `assertMeterQuota` sits in front of consultation create, summary
     * generation, transcription-job submit and every TTS request. Its meter
     * read fans out to six `aiUsageRollupDaily` aggregates plus a raw-ledger
     * scan; before this block existed, ANY failure of that read — a missing
     * relation, connection exhaustion, a slow aggregate, future schema drift —
     * propagated straight out of the assertion and became a 500 on the core
     * clinical workflow. Only `tts-ws.gateway.ts` wrapped the call, and it
     * catches `QuotaExceededException` and rethrows everything else.
     *
     * The asymmetry is deliberate: BILLING accuracy is worth less than the
     * clinician's request. A meter read that fails is skipped, not propagated.
     * Quantity/concurrency/storage quotas are unaffected — none of them reads
     * metering.
     *
     * A skipped check is a real event, not a shrug: it is logged at ERROR with
     * everything needed to diagnose it (tenant, capability, error class) AND
     * counted on a Prometheus counter, because a fail-open is invisible by
     * construction — the request succeeds either way, so without a signal
     * "metering has been down for six hours and nobody is being metered"
     * looks exactly like "nobody is over quota".
     */
    describe('fail-open when the metering read fails', () => {
      const arrangeFiniteLimit = () => {
        values.set('entitlements.enabled', true);
        asStarter(); // STARTER.monthlyConsultations = 50 — a finite, enforceable limit
      };

      it('does NOT propagate the metering failure — the caller still succeeds and nothing is blocked', async () => {
        arrangeFiniteLimit();
        metering.getCurrentUsage.mockRejectedValueOnce(new Error('relation "AiUsageRollupDaily" does not exist'));

        await expect(makeService().assertMeterQuota('tenant-1', 'monthlyConsultations')).resolves.toBeUndefined();
        // A skipped check is not a quota block — no block event, no 429.
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('logs the skipped check at ERROR with the tenant, capability and error class', async () => {
        arrangeFiniteLimit();
        const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        metering.getCurrentUsage.mockRejectedValueOnce(new TypeError('connection pool exhausted'));

        await makeService().assertMeterQuota('tenant-1', 'monthlySummaries', 3);

        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'tenant-1',
            capability: 'monthlySummaries',
            errorClass: 'TypeError',
            error: 'connection pool exhausted',
          }),
        );
        errorLog.mockRestore();
      });

      it('counts the skip on a Prometheus counter, labelled by capability', async () => {
        arrangeFiniteLimit();
        metering.getCurrentUsage.mockRejectedValueOnce(new Error('db down'));

        await makeService().assertMeterQuota('tenant-1', 'monthlyConsultations');

        expect(skipCounter.inc).toHaveBeenCalledWith({ capability: 'monthlyConsultations' });
      });

      it('still fails open when no metrics service is wired (the counter is best-effort, the skip is not)', async () => {
        arrangeFiniteLimit();
        metering.getCurrentUsage.mockRejectedValueOnce(new Error('db down'));
        const withoutMetrics = new EntitlementsService(
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
          undefined,
        );

        await expect(withoutMetrics.assertMeterQuota('tenant-1', 'monthlyConsultations')).resolves.toBeUndefined();
      });

      it('a QUANTITY quota still throws normally — the fail-open is scoped to the metering read', async () => {
        values.set('entitlements.enabled', true);
        asStarter(); // STARTER.maxUsers = 5

        await expect(makeService().assertQuantityQuota('tenant-1', 'maxUsers', 5)).rejects.toBeInstanceOf(QuotaExceededException);
      });
    });

    describe('Unit-allowance capabilities', () => {
      /*
       * An unlimited (null) allowance can never block, so the metering
       * aggregate it would be compared against is pure waste — and it is a
       * six-query fan-out on a clinical hot path. The resolved limit is
       * therefore checked BEFORE the meter is read: an ungated/unlimited tenant
       * never pays for the aggregate, and never inherits its failure modes.
       */
      it('is a NO-OP when the allowance is null (unlimited) — and never reads the live meter at all', async () => {
        values.set('entitlements.enabled', true);
        // ENTERPRISE is the tier that seeds every allowance NULL (negotiated).
        tenantRepository.findById.mockResolvedValue({ plan: 'ENTERPRISE', trialEndsAt: null });
        planEntitlementRepository.findByPlan.mockResolvedValue(null);
        tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

        await expect(makeService().assertMeterQuota('tenant-1', 'monthlyTtsCharacters', 500)).resolves.toBeUndefined();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        expect(metering.getCurrentUsage).not.toHaveBeenCalled();
      });

      it('throws QuotaExceededException once a finite TTS-character allowance is exceeded', async () => {
        values.set('entitlements.enabled', true);
        tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
        planEntitlementRepository.findByPlan.mockResolvedValue({ monthlyTtsCharacters: 10_000 });
        tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
        metering.getCurrentUsage.mockResolvedValueOnce({
          consultations: 0,
          transcriptionMinutes: 0,
          summaries: 0,
          sttSessionSeconds: 0,
          llmTokens: 0,
          ttsCharacters: 9_800,
          nlpTextUnits: 0,
          guardrailCalls: 0,
          embeddingTokens: 0,
        });

        // Pre-flight: THIS request would add 500 chars — 9,800 + 500 > 10,000.
        await expect(makeService().assertMeterQuota('tenant-1', 'monthlyTtsCharacters', 500)).rejects.toBeInstanceOf(QuotaExceededException);
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          ENTITLEMENTS_QUOTA_BLOCKED_EVENT,
          expect.objectContaining({ tenantId: 'tenant-1', capability: 'monthlyTtsCharacters', limit: 10_000, used: 9_800, requested: 500 }),
        );
      });

      it('reads llmTokens / sttSessionSeconds / nlpTextUnits / embeddingTokens off the correct MeterUsage field', async () => {
        values.set('entitlements.enabled', true);
        const usage = {
          consultations: 0,
          transcriptionMinutes: 0,
          summaries: 0,
          sttSessionSeconds: 111,
          llmTokens: 222,
          ttsCharacters: 333,
          nlpTextUnits: 444,
          guardrailCalls: 555,
          embeddingTokens: 666,
        };
        const cases: Array<[keyof typeof usage, 'monthlySttSessionSeconds' | 'monthlyLlmTokens' | 'monthlyNlpTextUnits' | 'monthlyEmbeddingTokens']> =
          [
            ['sttSessionSeconds', 'monthlySttSessionSeconds'],
            ['llmTokens', 'monthlyLlmTokens'],
            ['nlpTextUnits', 'monthlyNlpTextUnits'],
            ['embeddingTokens', 'monthlyEmbeddingTokens'],
          ];

        for (const [usageKey, capability] of cases) {
          tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
          planEntitlementRepository.findByPlan.mockResolvedValue({ [capability]: usage[usageKey] }); // limit == used exactly
          tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
          metering.getCurrentUsage.mockResolvedValueOnce(usage);

          // increment 0 → "used > limit" only; used == limit must NOT block.
          await expect(makeService().assertMeterQuota('tenant-1', capability, 0)).resolves.toBeUndefined();
          // increment 1 → used + 1 > limit → blocks.
          metering.getCurrentUsage.mockResolvedValueOnce(usage);
          await expect(makeService().assertMeterQuota('tenant-1', capability, 1)).rejects.toBeInstanceOf(QuotaExceededException);
        }
      });

      it('TRIAL hard-cap vs paid soft-cap: a finite TRIAL allowance blocks; the same usage under an unlimited (null) paid-tier allowance never blocks', async () => {
        values.set('entitlements.enabled', true);
        const heavyUsage = {
          consultations: 0,
          transcriptionMinutes: 0,
          summaries: 0,
          sttSessionSeconds: 0,
          llmTokens: 5_000_000,
          ttsCharacters: 0,
          nlpTextUnits: 0,
          guardrailCalls: 0,
          embeddingTokens: 0,
        };

        // TRIAL with an operator-set finite allowance — D12 "hard caps only for TRIAL".
        tenantRepository.findById.mockResolvedValue({ plan: 'TRIAL', trialEndsAt: null });
        planEntitlementRepository.findByPlan.mockResolvedValue({ monthlyLlmTokens: 5_000_000 });
        tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
        metering.getCurrentUsage.mockResolvedValueOnce(heavyUsage);
        await expect(makeService().assertMeterQuota('tenant-1', 'monthlyLlmTokens')).rejects.toBeInstanceOf(QuotaExceededException);

        // Same usage under ENTERPRISE, which seeds monthlyLlmTokens NULL (D12
        // "soft caps for paid tiers" — unlimited here means the quota gate
        // never blocks; overage billing is the invoice engine's job).
        tenantRepository.findById.mockResolvedValue({ plan: 'ENTERPRISE', trialEndsAt: null });
        planEntitlementRepository.findByPlan.mockResolvedValue(null);
        tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
        metering.getCurrentUsage.mockResolvedValueOnce(heavyUsage);
        await expect(makeService().assertMeterQuota('tenant-1', 'monthlyLlmTokens')).resolves.toBeUndefined();
      });
    });
  });

  describe('assertConcurrencyQuota (concurrency, hard-block → 429)', () => {
    // STARTER.maxConcurrentSessions = 5 in the seeded matrix.
    const asStarter = () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
    };

    it('is a NO-OP when the kill-switch is OFF — never reads the registry', async () => {
      values.set('entitlements.enabled', false);
      asStarter(); // enforcement default OFF
      await expect(makeService().assertConcurrencyQuota('tenant-1')).resolves.toBeUndefined();
      expect(socketRegistry.getTenantAggregateCount).not.toHaveBeenCalled();
      expect(tenantRepository.findById).not.toHaveBeenCalled();
    });

    it('is a NO-OP for an unlimited (reserved, plan-less → ungated) tenant', async () => {
      values.set('entitlements.enabled', true);
      tenantRepository.findById.mockResolvedValue({ plan: null, trialEndsAt: null });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);

      await expect(makeService().assertConcurrencyQuota(ENTITLEMENTS_TENANT_ID)).resolves.toBeUndefined();
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

  describe('evaluateStorageSoftWarn (never blocks)', () => {
    // STARTER.storageQuotaBytes = 5 GiB in the seeded matrix.
    const asStarter = () => {
      tenantRepository.findById.mockResolvedValue({ plan: 'STARTER', trialEndsAt: null });
      planEntitlementRepository.findByPlan.mockResolvedValue(null);
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
    };

    it('is a NO-OP (warn:false) when the kill-switch is OFF', async () => {
      values.set('entitlements.enabled', false);
      asStarter();
      const result = await makeService().evaluateStorageSoftWarn('tenant-1', 10 * GIB);
      expect(result.warn).toBe(false);
      expect(tenantService.getUsageStats).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('is a NO-OP for an unlimited (reserved, plan-less → ungated) tenant', async () => {
      values.set('entitlements.enabled', true);
      tenantRepository.findById.mockResolvedValue({ plan: null, trialEndsAt: null });
      tenantEntitlementRepository.findByTenant.mockResolvedValue(null);
      const result = await makeService().evaluateStorageSoftWarn(ENTITLEMENTS_TENANT_ID, 10 * GIB);
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
