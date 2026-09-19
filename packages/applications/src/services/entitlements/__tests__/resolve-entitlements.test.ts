import { describe, it, expect } from 'vitest';
import { TenantPlan } from '@arcaai/domains';
import { effectivePlan, resolveEntitlements, UNGATED_ENTITLEMENTS } from '../resolve-entitlements';
import {
  blendedReqPerMinutePerUser,
  DEFAULT_TENANT_PLAN,
  ENTITLEMENTS_GLOBAL_TENANT_ID,
  ENTITLEMENTS_TENANT_ID,
  GIB,
  PLAN_ENTITLEMENT_DEFAULTS,
  PLAN_RATE_LIMIT_SIZING,
} from '../entitlements.constants';

describe('resolveEntitlements', () => {
  describe('null plan → ungated-legacy', () => {
    it('resolves a null plan to the ungated snapshot (unlimited, all features on)', () => {
      const r = resolveEntitlements(null);
      expect(r.gated).toBe(false);
      expect(r.plan).toBeNull();
      expect(r.limits).toEqual(UNGATED_ENTITLEMENTS.limits);
      expect(Object.values(r.limits).every((v) => v === null)).toBe(true);
      // `platformDefaultCredential` is the ONE feature that is
      // NOT `true` for a null-plan tenant — see the dedicated test below.
      expect(r.features).toEqual({
        platformDefaultCredential: false,
        paletteStt: true,
        agenticLoop: true,
      });
      expect(r.modelTier).toBe('full_custom');
    });

    it('ignores a tenant override for a null plan (safety net stays ungated)', () => {
      const r = resolveEntitlements(null, null, { maxUsers: 1, featureAgenticLoop: false });
      expect(r.gated).toBe(false);
      expect(r.limits.maxUsers).toBeNull();
      expect(r.features.agenticLoop).toBe(true);
    });
  });

  describe('seeded defaults (no DB row, no override)', () => {
    it('STARTER matches the seeded matrix', () => {
      const r = resolveEntitlements(TenantPlan.STARTER);
      const d = PLAN_ENTITLEMENT_DEFAULTS.STARTER;
      expect(r.gated).toBe(true);
      expect(r.limits.maxUsers).toBe(5);
      // Derived from the matrix, not restated: these STRUCTURAL caps are sized to
      // what tenant creation provisions, so a duplicated literal here
      // just breaks whenever the provisioned catalog legitimately changes.
      expect(r.limits.maxDepartments).toBe(d.maxDepartments);
      expect(r.limits.maxAsrPipelines).toBe(d.maxAsrPipelines);
      expect(r.limits.storageQuotaBytes).toBe(5 * GIB);
      expect(r.limits.maxConcurrentSessions).toBe(5);
      // STARTER = $50/mo bundling 50 consultations.
      expect(r.limits.monthlyConsultations).toBe(50);
      expect(r.features).toEqual({
        platformDefaultCredential: false,
        paletteStt: true,
        // the loop is the differentiating plan feature; STARTER is out.
        agenticLoop: false,
      });
      expect(r.modelTier).toBe('base');
      expect(r.rateLimitTier).toBe('strict');
      // TASK-993 OD-1 — every plan now carries an ABSOLUTE ceiling; this used
      // to be null, which made the `strict` tier's 10/min the whole tenant's
      // budget. Derived from the matrix rather than restated, for the same
      // reason the structural caps above are.
      expect(r.rateLimitPerMinute).toBe(d.rateLimitPerMinute);
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

    it('ENTERPRISE carries 50% headroom over the 100-concurrent-user target, with negotiated (unlimited) usage', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE);
      // TASK-993 OD-4: the target is 100 CONCURRENT users per tenant, so a cap
      // of exactly 100 fails it — the 101st seat and an overlapping reconnect
      // are both refused. 150 is the target + 50%.
      expect(r.limits.maxUsers).toBe(150);
      expect(r.limits.maxConcurrentSessions).toBe(150);
      expect(r.limits.storageQuotaBytes).toBe(1_000 * GIB);
      // ENTERPRISE usage is negotiated — unlimited by default.
      expect(r.limits.monthlyConsultations).toBeNull();
      expect(r.features.agenticLoop).toBe(true);
      expect(r.modelTier).toBe('full_custom');
      expect(r.rateLimitTier).toBe('relaxed');
    });
  });

  /*
   * TASK-993 OD-1 — every plan now carries an ABSOLUTE `rateLimitPerMinute`
   * instead of inheriting its named tier's baseline (STARTER 10 / PRO 100 /
   * ENTERPRISE 300 per minute, for the WHOLE tenant across all routes and all
   * users). The tier name is unchanged on purpose: it still selects which named
   * throttler a request rides, and `RATE_LIMIT_TIER_DEFAULTS` is shared with
   * the rank-5 per-IP lane, so re-pointing it would move limits far outside the
   * plan matrix.
   */
  describe('per-plan absolute rate limit (TASK-993 OD-1)', () => {
    it('blends the MEASURED active and idle rates the way the ticket reports', () => {
      // 0.3 x 26.0 + 0.7 x 8.5. The whole platform model rests on this number:
      // 1,000 users x 13.75 = 13,750 req/min = ~229 req/s.
      expect(blendedReqPerMinutePerUser()).toBeCloseTo(13.75, 5);
    });

    it.each([
      [TenantPlan.STARTER, 5, 250],
      [TenantPlan.TRIAL, 25, 1_150],
      [TenantPlan.PRO, 25, 1_150],
      [TenantPlan.ENTERPRISE, 150, 6_650],
    ])('%s resolves an absolute tenant-aggregate ceiling of %i seats → %i req/min', (plan, seats, perMinute) => {
      const r = resolveEntitlements(plan);
      expect(r.limits.maxUsers).toBe(seats);
      expect(r.rateLimitPerMinute).toBe(perMinute);
    });

    /*
     * The shipped number must clear BOTH worst cases, whichever happens to
     * bind. Asserting the bounds rather than re-running the formula is the
     * point: a re-measurement that flips which branch wins must not be able to
     * ship a ceiling below either one.
     */
    it.each([
      [TenantPlan.STARTER, 5],
      [TenantPlan.TRIAL, 25],
      [TenantPlan.PRO, 25],
      [TenantPlan.ENTERPRISE, 150],
    ])('%s clears both the blended-model and the all-active worst-case bound', (plan, seats) => {
      const shipped = resolveEntitlements(plan).rateLimitPerMinute!;
      // model: realistic 30/70 mix, tripled (the owner's ratified headroom).
      expect(shipped).toBeGreaterThanOrEqual(seats * blendedReqPerMinutePerUser() * PLAN_RATE_LIMIT_SIZING.HEADROOM);
      // floor: every seat on the worst measured walk at once, no headroom.
      expect(shipped).toBeGreaterThanOrEqual(seats * PLAN_RATE_LIMIT_SIZING.MEASURED_WORST_CASE_REQ_PER_MINUTE);
      // legible in an admin UI.
      expect(shipped % 50).toBe(0);
    });

    it('is a real increase on every plan — the old tier baselines were 10 / 100 / 300 per minute', () => {
      const OLD_TIER_BASELINE = { STARTER: 10, TRIAL: 100, PRO: 100, ENTERPRISE: 300 } as const;
      for (const [plan, previous] of Object.entries(OLD_TIER_BASELINE)) {
        expect(resolveEntitlements(plan as TenantPlan).rateLimitPerMinute).toBeGreaterThan(previous);
      }
    });

    it('leaves the window to the named tier — an absolute count without a window is the supported shape', () => {
      for (const plan of [TenantPlan.STARTER, TenantPlan.TRIAL, TenantPlan.PRO, TenantPlan.ENTERPRISE]) {
        expect(resolveEntitlements(plan).rateLimitWindowMs).toBeNull();
      }
    });

    it('a per-tenant override still wins over the plan absolute', () => {
      const r = resolveEntitlements(TenantPlan.ENTERPRISE, null, { rateLimitPerMinute: 999 });
      expect(r.rateLimitPerMinute).toBe(999);
    });
  });

  describe('layer precedence: seeded ← DB plan row ← tenant override', () => {
    it('a DB plan row overrides the seeded constant', () => {
      const r = resolveEntitlements(TenantPlan.STARTER, { maxUsers: 8, rateLimitTier: 'default' });
      expect(r.limits.maxUsers).toBe(8);
      expect(r.rateLimitTier).toBe('default');
      // untouched fields still fall back to the seeded STARTER matrix
      expect(r.limits.maxDepartments).toBe(PLAN_ENTITLEMENT_DEFAULTS.STARTER.maxDepartments);
    });

    it('a tenant override wins over both the DB row and the seeded default', () => {
      const r = resolveEntitlements(
        TenantPlan.STARTER,
        { maxUsers: 8 },
        { maxUsers: 12, featureAgenticLoop: true, rateLimitTier: 'relaxed', rateLimitPerMinute: 600 },
      );
      expect(r.limits.maxUsers).toBe(12);
      // STARTER seeds `agenticLoop: false`; the tenant override wins.
      expect(r.features.agenticLoop).toBe(true);
      expect(r.rateLimitTier).toBe('relaxed');
      expect(r.rateLimitPerMinute).toBe(600);
    });

    it('a null override field inherits the plan default (does not zero it out)', () => {
      const r = resolveEntitlements(TenantPlan.PRO, null, { maxUsers: null, featureAgenticLoop: null, modelTier: null });
      expect(r.limits.maxUsers).toBe(25);
      expect(r.features.agenticLoop).toBe(true);
      expect(r.modelTier).toBe('full');
    });

    it('an override can turn a feature OFF (false is not treated as inherit)', () => {
      const r = resolveEntitlements(TenantPlan.PRO, null, { featureAgenticLoop: false });
      expect(r.features.agenticLoop).toBe(false);
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
      // TASK-993 OD-4 raised the ENTERPRISE anchor from 100 to 150.
      expect(r.limits.maxConcurrentSessions).toBe(PLAN_ENTITLEMENT_DEFAULTS.ENTERPRISE.maxConcurrentSessions);
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

  describe('Per-capability allowances (monthlySttSessionSeconds/monthlyLlmTokens/monthlyTtsCharacters/monthlyNlpTextUnits/monthlyEmbeddingTokens)', () => {
    it('seeds the ratified per-capability ceilings on the paid tiers', () => {
      // Derived from each plan's business ceilings × intensity constants × 2
      // headroom — see They are runaway guards, so they must sit
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
   * `featurePlatformDefaultCredential`.
   *
   * The grant that decides whether a tenant's provider-credential cascade may
   * reach the SYSTEM (platform-funded) tier. Resolution shape is identical to
   * the three existing booleans (plan default ← tri-state tenant override);
   * what is deliberately DIFFERENT is the ungated-legacy fallback and the
   * seeded plan matrix, both of which are `false`. See and
   */
  describe('platformDefaultCredential grant', () => {
    // 22
    it('a plan row granting featurePlatformDefaultCredential resolves the feature true', () => {
      const r = resolveEntitlements(TenantPlan.STARTER, { featurePlatformDefaultCredential: true });
      expect(r.features.platformDefaultCredential).toBe(true);
    });

    // 23 — the primary sales path (no plan grants it; grants are per tenant).
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
     * 26. `UNGATED_ENTITLEMENTS` resolves every OTHER boolean
     * feature `true` (a null-plan "ungated-legacy" tenant is unrestricted by
     * design). This one must be the FIRST to resolve `false`: the grant governs
     * whether the platform SPENDS MONEY on a tenant's behalf, so the ungated
     * fallback has to fail CLOSED. Restoring the "ungated ⇒ everything on"
     * symmetry silently grants the platform default to every null-plan tenant.
     */
    it('UNGATED_ENTITLEMENTS resolves platformDefaultCredential FALSE — the one asymmetric feature', () => {
      expect(UNGATED_ENTITLEMENTS.features.platformDefaultCredential).toBe(false);
      // …while its neighbours stay `true`, so the asymmetry is deliberate and
      // visible rather than an oversight in one direction or the other.
      expect(UNGATED_ENTITLEMENTS.features.paletteStt).toBe(true);
      expect(UNGATED_ENTITLEMENTS.features.agenticLoop).toBe(true);

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

  /*
   * the harness agentic loop as a SUBSCRIPTION FEATURE.
   *
   * The owner ruling (owner-decisions-2026-08-17.md §2 row 705) makes loop
   * eligibility commercial: a plan property resolved from the database, not an
   * environment switch. It resolves through exactly the same three layers as
   * every other boolean — seeded per-plan default ← plan row ← tri-state tenant
   * override. The `PlanEntitlement.featureAgenticLoop` /
   * `TenantEntitlement.featureAgenticLoop` columns now exist, so the per-plan
   * default lives in `PlanEntitlementValues` alongside every other feature and
   * the interim `AGENTIC_LOOP_PLAN_DEFAULTS` map is gone.
*/
  describe('agenticLoop entitlement ', () => {
    it('is the differentiating plan feature: off on STARTER, on for TRIAL/PRO/ENTERPRISE', () => {
      expect(resolveEntitlements(TenantPlan.STARTER).features.agenticLoop).toBe(false);
      for (const plan of [TenantPlan.TRIAL, TenantPlan.PRO, TenantPlan.ENTERPRISE]) {
        expect(resolveEntitlements(plan).features.agenticLoop, `${plan}`).toBe(true);
      }
      expect(PLAN_ENTITLEMENT_DEFAULTS.STARTER.featureAgenticLoop).toBe(false);
      for (const plan of [TenantPlan.TRIAL, TenantPlan.PRO, TenantPlan.ENTERPRISE]) {
        expect(PLAN_ENTITLEMENT_DEFAULTS[plan].featureAgenticLoop, `${plan}`).toBe(true);
      }
    });

    it('a null-plan (ungated-legacy) tenant keeps the loop — day-1 posture (D-A)', () => {
      expect(UNGATED_ENTITLEMENTS.features.agenticLoop).toBe(true);
      expect(resolveEntitlements(null).features.agenticLoop).toBe(true);
    });

    it('a plan row overrides the seeded per-plan default', () => {
      expect(resolveEntitlements(TenantPlan.STARTER, { featureAgenticLoop: true }).features.agenticLoop).toBe(true);
      expect(resolveEntitlements(TenantPlan.PRO, { featureAgenticLoop: false }).features.agenticLoop).toBe(false);
    });

    it('a per-tenant override beats the plan in BOTH directions; null = inherit', () => {
      expect(resolveEntitlements(TenantPlan.STARTER, null, { featureAgenticLoop: true }).features.agenticLoop).toBe(true);
      expect(resolveEntitlements(TenantPlan.PRO, null, { featureAgenticLoop: false }).features.agenticLoop).toBe(false);
      expect(resolveEntitlements(TenantPlan.PRO, null, { featureAgenticLoop: null }).features.agenticLoop).toBe(true);
      expect(resolveEntitlements(TenantPlan.STARTER, null, { featureAgenticLoop: null }).features.agenticLoop).toBe(false);
    });

    it('never resolves from another tenant: the resolver only ever sees THIS tenant’s rows', () => {
      // Tenant A is on STARTER with no override; tenant B is on PRO. Resolving A
      // with A's inputs can never pick up B's plan — the resolver is pure and
      // takes one tenant's three layers at a time.
      const a = resolveEntitlements(TenantPlan.STARTER, null, null);
      const b = resolveEntitlements(TenantPlan.PRO, null, null);
      expect(a.features.agenticLoop).toBe(false);
      expect(b.features.agenticLoop).toBe(true);
    });
  });
});

describe('effectivePlan — a plan-less tenant defaults to STARTER (OD-5)', () => {
  const CUSTOMER = '11111111-1111-1111-1111-111111111111';

  it('resolves a customer tenant with no plan to STARTER, not ungated', () => {
    expect(effectivePlan(CUSTOMER, null)).toBe(DEFAULT_TENANT_PLAN);
    expect(DEFAULT_TENANT_PLAN).toBe(TenantPlan.STARTER);
  });

  it('leaves an explicitly stamped plan untouched', () => {
    expect(effectivePlan(CUSTOMER, TenantPlan.ENTERPRISE)).toBe(TenantPlan.ENTERPRISE);
  });

  it('keeps the SYSTEM tenant ungated — it is a config tier, never a customer', () => {
    expect(effectivePlan(ENTITLEMENTS_TENANT_ID, null)).toBeNull();
  });

  it('keeps the Global playground tenant ungated — gating it would break the platform-admin playground', () => {
    expect(effectivePlan(ENTITLEMENTS_GLOBAL_TENANT_ID, null)).toBeNull();
  });

  it('honours an explicit plan even on a reserved tenant (the default is what changes, never stated intent)', () => {
    expect(effectivePlan(ENTITLEMENTS_GLOBAL_TENANT_ID, TenantPlan.PRO)).toBe(TenantPlan.PRO);
  });

  it('puts a plan-less customer on the STRICT rate-limit tier, not the loosest one', () => {
    // Before OD-5 a plan-less tenant resolved `relaxed` (300/min) — LOOSER than
    // the 100/min platform default. That inversion is what this fixes.
    const before = resolveEntitlements(null);
    const after = resolveEntitlements(effectivePlan(CUSTOMER, null));
    expect(before.rateLimitTier).toBe('relaxed');
    expect(after.rateLimitTier).toBe('strict');
  });

  it('makes a plan-less customer gated, so its tenant override is finally honoured', () => {
    // `resolveEntitlements(null, …)` deliberately ignores overrides; routing the
    // tenant through STARTER means a super admin can now override it at all.
    const r = resolveEntitlements(effectivePlan(CUSTOMER, null), null, { maxUsers: 20 });
    expect(r.gated).toBe(true);
    expect(r.limits.maxUsers).toBe(20);
  });

  it('still resolves reserved tenants to the ungated snapshot end-to-end', () => {
    const r = resolveEntitlements(effectivePlan(ENTITLEMENTS_TENANT_ID, null));
    expect(r.gated).toBe(false);
    expect(r.limits).toEqual(UNGATED_ENTITLEMENTS.limits);
  });
});

/*
 * TASK-958 D-8 — the provider-CONNECTION ceiling.
 *
 * `maxAiProviderConnections` landed (Lane B1) before its DB column existed, so
 * it was resolved BESIDE the seeded matrix with a hardcoded `null` standing in
 * for the plan default. Now that `PlanEntitlement` carries the column, it folds
 * through the same three layers as every sibling limit, and these tests pin
 * that: the seeded matrix is genuinely consulted, and precedence is
 * seeded ← plan row ← tenant override.
 */
describe('maxAiProviderConnections (D-8)', () => {
  it('falls back to the SEEDED matrix, not a hardcoded null, when no DB row is present', () => {
    // Mutating the matrix is the only way to tell "reads the seeded default"
    // apart from "returns null because every seeded default happens to be null".
    const seeded = PLAN_ENTITLEMENT_DEFAULTS[TenantPlan.PRO];
    const original = seeded.maxAiProviderConnections;
    seeded.maxAiProviderConnections = 7;
    try {
      expect(resolveEntitlements(TenantPlan.PRO).limits.maxAiProviderConnections).toBe(7);
    } finally {
      seeded.maxAiProviderConnections = original;
    }
  });

  it('resolves the plan row when one is present', () => {
    const r = resolveEntitlements(TenantPlan.PRO, { maxAiProviderConnections: 3 });
    expect(r.limits.maxAiProviderConnections).toBe(3);
  });

  it('lets the tenant override win over the plan row', () => {
    const r = resolveEntitlements(TenantPlan.PRO, { maxAiProviderConnections: 3 }, { maxAiProviderConnections: 1 });
    expect(r.limits.maxAiProviderConnections).toBe(1);
  });

  it('inherits the plan row when the override leaves the field null (null = inherit)', () => {
    const r = resolveEntitlements(TenantPlan.PRO, { maxAiProviderConnections: 3 }, { maxAiProviderConnections: null });
    expect(r.limits.maxAiProviderConnections).toBe(3);
  });

  it('is unbounded (null) everywhere by default — the seeded value on every plan', () => {
    for (const plan of [TenantPlan.STARTER, TenantPlan.TRIAL, TenantPlan.PRO, TenantPlan.ENTERPRISE]) {
      expect(resolveEntitlements(plan).limits.maxAiProviderConnections, `plan ${plan}`).toBeNull();
      expect(PLAN_ENTITLEMENT_DEFAULTS[plan].maxAiProviderConnections, `seeded ${plan}`).toBeNull();
    }
    expect(UNGATED_ENTITLEMENTS.limits.maxAiProviderConnections).toBeNull();
  });
});
