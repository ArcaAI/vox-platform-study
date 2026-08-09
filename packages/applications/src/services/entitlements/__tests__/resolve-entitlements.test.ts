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
      // TASK-643 §0(3): `platformDefaultCredential` is the ONE feature that is
      // NOT `true` for a null-plan tenant — see the dedicated test below.
      expect(r.features).toEqual({ dnaReports: true, voiceEnrollment: true, monitoringAccess: true, platformDefaultCredential: false });
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
      // TASK-638: STARTER = $50/mo bundling 50 consultations.
      expect(r.limits.monthlyConsultations).toBe(50);
      expect(r.features).toEqual({ dnaReports: false, voiceEnrollment: false, monitoringAccess: false, platformDefaultCredential: false });
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
      // TASK-638: ENTERPRISE usage is negotiated — unlimited by default.
      expect(r.limits.monthlyConsultations).toBeNull();
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
      const r = resolveEntitlements(TenantPlan.PRO, null, { maxUsers: null, featureVoiceEnrollment: null, modelTier: null });
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
      const r = resolveEntitlements(TenantPlan.ENTERPRISE, { storageQuotaBytes: BigInt(2_000) * BigInt(GIB) });
      expect(typeof r.limits.storageQuotaBytes).toBe('number');
      expect(r.limits.storageQuotaBytes).toBe(2_000 * GIB);
    });

    it('normalizes a bigint override too', () => {
      const r = resolveEntitlements(TenantPlan.STARTER, null, { storageQuotaBytes: BigInt(10 * GIB) });
      expect(r.limits.storageQuotaBytes).toBe(10 * GIB);
    });
  });

  describe('TASK-615 D11 per-capability allowances (monthlySttSessionSeconds/monthlyLlmTokens/monthlyTtsCharacters/monthlyNlpTextUnits/monthlyEmbeddingTokens)', () => {
    it('seeds the ratified per-capability ceilings on the paid tiers (TASK-638)', () => {
      // Derived from each plan's business ceilings × intensity constants × 2
      // headroom — see TASK-638 §6. They are runaway guards, so they must sit
      // well ABOVE what the consultation cap alone permits.
      const starter = resolveEntitlements(TenantPlan.STARTER);
      expect(starter.limits.monthlySttSessionSeconds).toBe(132_000);
      expect(starter.limits.monthlyLlmTokens).toBe(600_000);
      expect(starter.limits.monthlyTtsCharacters).toBe(200_000);
      expect(starter.limits.monthlyNlpTextUnits).toBe(3_000);
      expect(starter.limits.monthlyEmbeddingTokens).toBe(150_000);

      for (const plan of [TenantPlan.TRIAL, TenantPlan.PRO]) {
        const r = resolveEntitlements(plan);
        expect(r.limits.monthlySttSessionSeconds).toBe(660_000);
        expect(r.limits.monthlyLlmTokens).toBe(3_000_000);
        expect(r.limits.monthlyTtsCharacters).toBe(1_000_000);
        expect(r.limits.monthlyNlpTextUnits).toBe(15_000);
        expect(r.limits.monthlyEmbeddingTokens).toBe(750_000);
      }
    });

    it('ENTERPRISE stays unlimited across every allowance — usage is negotiated per contract', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE);
      expect(r.limits.monthlySttSessionSeconds).toBeNull();
      expect(r.limits.monthlyLlmTokens).toBeNull();
      expect(r.limits.monthlyTtsCharacters).toBeNull();
      expect(r.limits.monthlyNlpTextUnits).toBeNull();
      expect(r.limits.monthlyEmbeddingTokens).toBeNull();
    });

    it('a null plan (ungated-legacy) has unlimited allowances too', () => {
      const r = resolveEntitlements(null);
      expect(r.limits.monthlySttSessionSeconds).toBeNull();
      expect(r.limits.monthlyLlmTokens).toBeNull();
      expect(r.limits.monthlyTtsCharacters).toBeNull();
      expect(r.limits.monthlyNlpTextUnits).toBeNull();
      expect(r.limits.monthlyEmbeddingTokens).toBeNull();
    });

    it('a DB plan row can set a finite allowance ceiling', () => {
      const r = resolveEntitlements(TenantPlan.TRIAL, { monthlyLlmTokens: 500_000 });
      expect(r.limits.monthlyLlmTokens).toBe(500_000);
      // untouched allowance fields fall through to the plan default (TRIAL = PRO)
      expect(r.limits.monthlyTtsCharacters).toBe(1_000_000);
    });

    it('a per-tenant override wins over the plan row (negotiated enterprise allowance)', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE, { monthlyLlmTokens: 10_000_000 }, { monthlyLlmTokens: 50_000_000 });
      expect(r.limits.monthlyLlmTokens).toBe(50_000_000);
    });

    it('a null override inherits the plan default (does not zero it out)', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE, { monthlyTtsCharacters: 1_000_000 }, { monthlyTtsCharacters: null });
      expect(r.limits.monthlyTtsCharacters).toBe(1_000_000);
    });

    it('normalizes a bigint allowance (Prisma returns BigInt for these columns too)', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE, { monthlySttSessionSeconds: BigInt(3_600_000) });
      expect(typeof r.limits.monthlySttSessionSeconds).toBe('number');
      expect(r.limits.monthlySttSessionSeconds).toBe(3_600_000);
    });

    it('normalizes a bigint allowance override too', () => {
      const r = resolveEntitlements(TenantPlan.STARTER, null, { monthlyNlpTextUnits: BigInt(200_000) });
      expect(r.limits.monthlyNlpTextUnits).toBe(200_000);
    });

    it('TRIAL mirrors PRO exactly for the new allowances too', () => {
      const trial = resolveEntitlements(TenantPlan.TRIAL);
      const pro = resolveEntitlements(TenantPlan.PRO);
      expect(trial.limits.monthlyLlmTokens).toBe(pro.limits.monthlyLlmTokens);
      expect(trial.limits.monthlyEmbeddingTokens).toBe(pro.limits.monthlyEmbeddingTokens);
    });
  });

  /*
   * TASK-643 R6 — `featurePlatformDefaultCredential`.
   *
   * The grant that decides whether a tenant's provider-credential cascade may
   * reach the SYSTEM (platform-funded) tier. Resolution shape is identical to
   * the three existing booleans (plan default ← tri-state tenant override);
   * what is deliberately DIFFERENT is the ungated-legacy fallback and the
   * seeded plan matrix, both of which are `false`. See §0(3) and §3.5.2.
   */
  describe('TASK-643 platformDefaultCredential grant', () => {
    // 22
    it('a plan row granting featurePlatformDefaultCredential resolves the feature true', () => {
      const r = resolveEntitlements(TenantPlan.STARTER, { featurePlatformDefaultCredential: true });
      expect(r.features.platformDefaultCredential).toBe(true);
    });

    // 23 — the primary sales path (§3.5.2: no plan grants it; grants are per tenant).
    it('a per-tenant override grants it over a plan default of false', () => {
      const r = resolveEntitlements(TenantPlan.PRO, { featurePlatformDefaultCredential: false }, { featurePlatformDefaultCredential: true });
      expect(r.features.platformDefaultCredential).toBe(true);
    });

    // 24 — the tri-state's third state is not decorative.
    it('an explicit tenant deny (false) beats a plan grant (true)', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE, { featurePlatformDefaultCredential: true }, { featurePlatformDefaultCredential: false });
      expect(r.features.platformDefaultCredential).toBe(false);
    });

    // 25 — null = inherit, in BOTH directions.
    it('a null tenant override inherits the plan value (neither forced true nor false)', () => {
      const granted = resolveEntitlements(TenantPlan.PRO, { featurePlatformDefaultCredential: true }, { featurePlatformDefaultCredential: null });
      expect(granted.features.platformDefaultCredential).toBe(true);

      const ungranted = resolveEntitlements(TenantPlan.PRO, { featurePlatformDefaultCredential: false }, { featurePlatformDefaultCredential: null });
      expect(ungranted.features.platformDefaultCredential).toBe(false);
    });

    /*
     * 26 — TASK-643 §0(3). `UNGATED_ENTITLEMENTS` resolves every OTHER boolean
     * feature `true` (a null-plan "ungated-legacy" tenant is unrestricted by
     * design). This one must be the FIRST to resolve `false`: the grant governs
     * whether the platform SPENDS MONEY on a tenant's behalf, so the ungated
     * fallback has to fail CLOSED. Restoring the "ungated ⇒ everything on"
     * symmetry silently grants the platform default to every null-plan tenant.
     */
    it('UNGATED_ENTITLEMENTS resolves platformDefaultCredential FALSE — the one asymmetric feature (§0(3))', () => {
      expect(UNGATED_ENTITLEMENTS.features.platformDefaultCredential).toBe(false);
      // …while its three neighbours stay `true`, so the asymmetry is deliberate
      // and visible rather than an oversight in one direction or the other.
      expect(UNGATED_ENTITLEMENTS.features.dnaReports).toBe(true);
      expect(UNGATED_ENTITLEMENTS.features.voiceEnrollment).toBe(true);
      expect(UNGATED_ENTITLEMENTS.features.monitoringAccess).toBe(true);

      // …and the resolver actually returns it for a null plan.
      expect(resolveEntitlements(null).features.platformDefaultCredential).toBe(false);
    });

    // 27 — OD-7: `false` on all four plans; grants are per tenant only.
    it('every seeded plan defaults to false (OD-7 — no plan tier carries the grant)', () => {
      for (const plan of [TenantPlan.STARTER, TenantPlan.TRIAL, TenantPlan.PRO, TenantPlan.ENTERPRISE]) {
        expect(PLAN_ENTITLEMENT_DEFAULTS[plan].featurePlatformDefaultCredential, `${plan} matrix default`).toBe(false);
        expect(resolveEntitlements(plan).features.platformDefaultCredential, `${plan} resolved`).toBe(false);
      }
    });
  });
});
