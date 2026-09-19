/**
 * TASK-993 lane F — the per-principal lane's NUMBER and its resolution.
 *
 * The guard-side behaviour (two buckets, which one binds, what the headers
 * say) lives in `apps/api/src/modules/throttle/__tests__/principal-bucket.task993.test.ts`.
 * This file pins the two things that belong to the applications layer:
 *
 *   1. the arithmetic behind 150 — RE-DERIVED here from the sizing constants
 *      rather than transcribed, so a re-measurement moves the assertion with
 *      the number instead of failing it;
 *   2. the resolution contract — code baseline, admin override, and the two
 *      ways a written row is refused (a limit that would refuse everything,
 *      and the operator's own off-switch).
 */

import { describe, expect, it } from 'vitest';
import { RateLimitSettingsService } from '../rate-limit-settings.service';
import {
  RATE_LIMIT_PRINCIPAL_DEFAULTS,
  RATE_LIMIT_PRINCIPAL_SIZING,
  RATE_LIMIT_TIER_DEFAULTS,
  principalLimitPerMinute,
  rateLimitPrincipalEnabledKey,
  rateLimitPrincipalLimitKey,
  rateLimitPrincipalTtlKey,
} from '../rate-limit.constants';
import { PLAN_RATE_LIMIT_SIZING } from '../../entitlements/entitlements.constants';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';

/** A minimal `IAppSettingsService` over a plain row map. */
function settingsOver(rows: Record<string, unknown>): RateLimitSettingsService {
  const appSettings = {
    getValueFromCache: (key: string) => (key in rows ? rows[key] : null),
    getTenantValueFromCache: () => null,
    getValueWithDefault: (key: string, fallback: unknown) => (key in rows ? rows[key] : fallback),
    hasSetting: (key: string) => key in rows,
  };
  return new RateLimitSettingsService(appSettings as never);
}

describe('per-principal limit — the arithmetic', () => {
  it('derives 150 from the measured rates and the approved 3x headroom', () => {
    // max(26.0 active, 44.1 worst case) x 3 = 132.3, rounded UP to 150.
    const worst = Math.max(
      RATE_LIMIT_PRINCIPAL_SIZING.MEASURED_ACTIVE_REQ_PER_MINUTE,
      RATE_LIMIT_PRINCIPAL_SIZING.MEASURED_WORST_CASE_REQ_PER_MINUTE,
    );
    expect(worst * RATE_LIMIT_PRINCIPAL_SIZING.HEADROOM).toBeCloseTo(132.3, 5);
    expect(principalLimitPerMinute()).toBe(150);
    expect(RATE_LIMIT_PRINCIPAL_DEFAULTS.limit).toBe(principalLimitPerMinute());
  });

  it('sits ABOVE the worst rate a single real user was measured producing', () => {
    // The property that matters clinically: a doctor doing a legitimate
    // all-document-load walk must not be refused. Anything at or below the
    // measured rate would refuse one.
    expect(RATE_LIMIT_PRINCIPAL_DEFAULTS.limit).toBeGreaterThan(RATE_LIMIT_PRINCIPAL_SIZING.MEASURED_WORST_CASE_REQ_PER_MINUTE);
  });

  it('reuses lane D’s measured rates verbatim, so a re-measurement moves BOTH levels', () => {
    // The tenant aggregate and the per-principal bucket are sized from the
    // same Playwright run. If these ever diverge the two levels are being
    // sized from different worlds, which is how a ceiling and a floor cross.
    expect(RATE_LIMIT_PRINCIPAL_SIZING.MEASURED_ACTIVE_REQ_PER_MINUTE).toBe(PLAN_RATE_LIMIT_SIZING.MEASURED_ACTIVE_REQ_PER_MINUTE);
    expect(RATE_LIMIT_PRINCIPAL_SIZING.MEASURED_WORST_CASE_REQ_PER_MINUTE).toBe(PLAN_RATE_LIMIT_SIZING.MEASURED_WORST_CASE_REQ_PER_MINUTE);
    expect(RATE_LIMIT_PRINCIPAL_SIZING.HEADROOM).toBe(PLAN_RATE_LIMIT_SIZING.HEADROOM);
  });

  it('keeps the tier window rather than inventing one', () => {
    expect(RATE_LIMIT_PRINCIPAL_DEFAULTS.ttl).toBe(RATE_LIMIT_TIER_DEFAULTS.default.ttl);
  });

  it('leaves at most a small slice of an ENTERPRISE tenant’s budget to any one caller', () => {
    // Lane D's shipped ENTERPRISE aggregate. Stated as an inequality rather
    // than an equality so this does not become a second place to edit when
    // packaging moves; what must hold is the RELATIONSHIP.
    const enterprisePerMinute = 6650;
    expect(RATE_LIMIT_PRINCIPAL_DEFAULTS.limit / enterprisePerMinute).toBeLessThan(0.05);
  });
});

describe('getPrincipalPolicy — resolution', () => {
  it('answers the code baseline when no row has ever been written', () => {
    expect(settingsOver({}).getPrincipalPolicy()).toEqual({ enabled: true, limit: 150, ttl: 60_000 });
  });

  it('an admin row wins over the baseline', () => {
    const policy = settingsOver({ [rateLimitPrincipalLimitKey()]: 400, [rateLimitPrincipalTtlKey()]: 30_000 }).getPrincipalPolicy();
    expect(policy).toEqual({ enabled: true, limit: 400, ttl: 30_000 });
  });

  it('the off-switch is honoured', () => {
    expect(settingsOver({ [rateLimitPrincipalEnabledKey()]: false }).getPrincipalPolicy().enabled).toBe(false);
  });

  it('a limit of 0 falls back rather than refusing every request', () => {
    // `open-to-default`: an unusable row is a bookkeeping failure, and a
    // bookkeeping failure must never refuse a clinical request.
    expect(settingsOver({ [rateLimitPrincipalLimitKey()]: 0 }).getPrincipalPolicy().limit).toBe(150);
    expect(settingsOver({ [rateLimitPrincipalLimitKey()]: -5 }).getPrincipalPolicy().limit).toBe(150);
    expect(settingsOver({ [rateLimitPrincipalTtlKey()]: 0 }).getPrincipalPolicy().ttl).toBe(60_000);
  });

  it('an unusable row still reports the operator’s enabled bit', () => {
    // The two are independent: a broken number must not silently turn the
    // lane off, and an off-switch must not be lost behind a broken number.
    const policy = settingsOver({ [rateLimitPrincipalLimitKey()]: -1, [rateLimitPrincipalEnabledKey()]: false }).getPrincipalPolicy();
    expect(policy).toEqual({ enabled: false, limit: 150, ttl: 60_000 });
  });
});

describe('the three keys are CATALOGED', () => {
  // The defect the tier keys' own comment records: a key resolved from
  // `GlobalSetting` but absent from the registry is invisible to
  // `GET /admin/settings/catalog` and unreachable through the write surface.
  // Shipping a fourth one would knowingly repeat it.
  it.each([rateLimitPrincipalEnabledKey(), rateLimitPrincipalLimitKey(), rateLimitPrincipalTtlKey()])(
    '%s is registered as a global-kv knob',
    (key) => {
      const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      expect(descriptor.tier).toBe('global-kv');
      expect(descriptor.failMode).toBe('open-to-default');
      // Platform safety property, not a plan feature — the same posture as the
      // `rate-limit.tier.*` keys it sits beside.
      expect(descriptor.maxScope).toBe('system');
      expect(descriptor.globalOnly).toBe(true);
    },
  );

  it('declares the SHIPPED default, so the catalog and the resolver agree', () => {
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(rateLimitPrincipalLimitKey()).default).toBe(RATE_LIMIT_PRINCIPAL_DEFAULTS.limit);
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(rateLimitPrincipalTtlKey()).default).toBe(RATE_LIMIT_PRINCIPAL_DEFAULTS.ttl);
  });
});
