import { describe, it, expect } from 'vitest';
import { TenantPlan } from '@arcaai/domains';
import { resolveEntitlements, UNGATED_ENTITLEMENTS } from '../resolve-entitlements';
import { GIB, PLAN_ENTITLEMENT_DEFAULTS } from '../entitlements.constants';

describe('resolveEntitlements', () => {
  describe('null plan → ungated-legacy', () => {
    it('resolves a null plan to the ungated snapshot (unlimited, all features on)', () => {
      const r = resolveEntitlements(null);
      expect(r.gated).toBe(false);
      expect(r.plan).toBeNull();
      expect(r.limits).toEqual(UNGATED_ENTITLEMENTS.limits);
      expect(Object.values(r.limits).every((v) => v === null)).toBe(true);
      expect(r.features).toEqual({ dnaReports: true, voiceEnrollment: true, monitoringAccess: true });
      expect(r.modelTier).toBe('full_custom');
    });

    it('ignores a tenant override for a null plan (safety net stays ungated)', () => {
      const r = resolveEntitlements(null, null, { maxUsers: 1, featureMonitoringAccess: false });
      expect(r.gated).toBe(false);
      expect(r.limits.maxUsers).toBeNull();
      expect(r.features.monitoringAccess).toBe(true);
    });
  });

  describe('seeded defaults (no DB row, no override)', () => {
    it('STARTER matches the seeded matrix', () => {
      const r = resolveEntitlements(TenantPlan.STARTER);
      const d = PLAN_ENTITLEMENT_DEFAULTS.STARTER;
      expect(r.gated).toBe(true);
      expect(r.limits.maxUsers).toBe(5);
      expect(r.limits.maxDepartments).toBe(2);
      expect(r.limits.storageQuotaBytes).toBe(5 * GIB);
      expect(r.limits.maxConcurrentSessions).toBe(5);
      expect(r.limits.monthlyConsultations).toBe(500);
      expect(r.features).toEqual({ dnaReports: false, voiceEnrollment: false, monitoringAccess: false });
      expect(r.modelTier).toBe('base');
      expect(r.rateLimitTier).toBe('strict');
      expect(r.rateLimitPerMinute).toBeNull();
      expect(r.limits.maxAsrPipelines).toBe(d.maxAsrPipelines);
    });

    it('TRIAL mirrors PRO exactly', () => {
      const trial = resolveEntitlements(TenantPlan.TRIAL);
      const pro = resolveEntitlements(TenantPlan.PRO);
      expect(trial.limits).toEqual(pro.limits);
      expect(trial.features).toEqual(pro.features);
      expect(trial.modelTier).toBe(pro.modelTier);
      expect(trial.rateLimitTier).toBe(pro.rateLimitTier);
    });

    it('ENTERPRISE is anchored at ~100 seats and unlocks monitoring', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE);
      expect(r.limits.maxUsers).toBe(100);
      expect(r.limits.maxConcurrentSessions).toBe(100);
      expect(r.limits.storageQuotaBytes).toBe(1_000 * GIB);
      expect(r.limits.monthlyConsultations).toBe(50_000);
      expect(r.features.monitoringAccess).toBe(true);
      expect(r.modelTier).toBe('full_custom');
      expect(r.rateLimitTier).toBe('relaxed');
    });
  });

  describe('layer precedence: seeded ← DB plan row ← tenant override', () => {
    it('a DB plan row overrides the seeded constant', () => {
      const r = resolveEntitlements(TenantPlan.STARTER, { maxUsers: 8, rateLimitTier: 'default' });
      expect(r.limits.maxUsers).toBe(8);
      expect(r.rateLimitTier).toBe('default');
      // untouched fields still fall back to the seeded STARTER matrix
      expect(r.limits.maxDepartments).toBe(2);
    });

    it('a tenant override wins over both the DB row and the seeded default', () => {
      const r = resolveEntitlements(
        TenantPlan.STARTER,
        { maxUsers: 8 },
        { maxUsers: 12, featureDnaReports: true, rateLimitTier: 'relaxed', rateLimitPerMinute: 600 },
      );
      expect(r.limits.maxUsers).toBe(12);
      expect(r.features.dnaReports).toBe(true);
      expect(r.rateLimitTier).toBe('relaxed');
      expect(r.rateLimitPerMinute).toBe(600);
    });

    it('a null override field inherits the plan default (does not zero it out)', () => {
      const r = resolveEntitlements(
        TenantPlan.PRO,
        null,
        { maxUsers: null, featureVoiceEnrollment: null, modelTier: null },
      );
      expect(r.limits.maxUsers).toBe(25);
      expect(r.features.voiceEnrollment).toBe(true);
      expect(r.modelTier).toBe('full');
    });

    it('an override can turn a feature OFF (false is not treated as inherit)', () => {
      const r = resolveEntitlements(TenantPlan.PRO, null, { featureVoiceEnrollment: false });
      expect(r.features.voiceEnrollment).toBe(false);
    });
  });

  describe('concurrency limit (maxConcurrentSessions, additive)', () => {
    it('seeds PRO/TRIAL ≈ 25 concurrent sessions', () => {
      expect(resolveEntitlements(TenantPlan.PRO).limits.maxConcurrentSessions).toBe(25);
      expect(resolveEntitlements(TenantPlan.TRIAL).limits.maxConcurrentSessions).toBe(25);
    });

    it('a DB plan row then a per-tenant override raise the concurrency cap ("increase on demand")', () => {
      const withRow = resolveEntitlements(TenantPlan.STARTER, { maxConcurrentSessions: 8 });
      expect(withRow.limits.maxConcurrentSessions).toBe(8);

      const withOverride = resolveEntitlements(TenantPlan.STARTER, { maxConcurrentSessions: 8 }, { maxConcurrentSessions: 30 });
      expect(withOverride.limits.maxConcurrentSessions).toBe(30);
    });

    it('a null override inherits the plan concurrency default (does not zero it out)', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE, null, { maxConcurrentSessions: null });
      expect(r.limits.maxConcurrentSessions).toBe(100);
    });

    it('a null-plan (ungated) tenant has unlimited concurrency', () => {
      expect(resolveEntitlements(null).limits.maxConcurrentSessions).toBeNull();
    });
  });

  describe('bigint storage normalization (Prisma returns BigInt)', () => {
    it('normalizes a bigint storageQuotaBytes to a number', () => {
      const r = resolveEntitlements(
        TenantPlan.ENTERPRISE,
        { storageQuotaBytes: BigInt(2_000) * BigInt(GIB) },
      );
      expect(typeof r.limits.storageQuotaBytes).toBe('number');
      expect(r.limits.storageQuotaBytes).toBe(2_000 * GIB);
    });

    it('normalizes a bigint override too', () => {
      const r = resolveEntitlements(
        TenantPlan.STARTER,
        null,
        { storageQuotaBytes: BigInt(10 * GIB) },
      );
      expect(r.limits.storageQuotaBytes).toBe(10 * GIB);
    });
  });
});
