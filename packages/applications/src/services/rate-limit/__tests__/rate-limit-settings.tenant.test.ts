/**
 * TASK-558 lane I — THE HEADLINE PROOF.
 *
 * "Changing a rate limit for ONE tenant changes that tenant's behaviour and no
 * other, with no redeploy."
 *
 * `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_ENABLED` used
 * to be `process.env` reads in `RateLimitConfigService`, evaluated ONCE while
 * the throttler module was being constructed — so changing a limit meant a
 * redeploy, and every tenant got the same number. They are now `global-kv` keys
 * at `maxScope: 'tenant'`, resolved on the request path.
 *
 * Also pinned here, because a per-tenant limit is only safe with them:
 *   • the entitlement CEILING (§9.3 M2) — a tenant cannot raise itself above
 *     its plan;
 *   • the platform bound — a tenant cannot raise itself above the platform
 *     value, or switch its own throttling off.
 */
import { describe, expect, it } from 'vitest';
import { RateLimitSettingsService } from '../rate-limit-settings.service';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { RATE_LIMIT_TIER_DEFAULTS } from '../rate-limit.constants';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function build(platform: Record<string, unknown> = {}, tenant: Record<string, Record<string, unknown>> = {}) {
  const appSettings = {
    getValueFromCache: (key: string) => (key in platform ? platform[key] : null),
    getTenantValueFromCache: (tenantId: string, key: string) => {
      const rows = tenant[tenantId];
      return rows && key in rows ? rows[key] : null;
    },
    getValueWithDefault: <T>(key: string, fallback: T): T => (key in platform ? (platform[key] as T) : fallback),
    hasSetting: (key: string) => key in platform,
  };
  return new RateLimitSettingsService(appSettings as never, new TenantSettingsService(appSettings as never));
}

describe('RateLimitSettingsService — per-tenant default tier', () => {
  it('serves the PLATFORM baseline to a tenant with no override', () => {
    const service = build({ 'rateLimit.maxRequests': 100, 'rateLimit.windowMs': 60_000 });
    expect(service.getTierForTenant('default', TENANT_A)).toMatchObject({ limit: 100, ttl: 60_000, limitSource: 'system', ttlSource: 'system' });
  });

  it('serves ONE tenant its own limit and leaves every other tenant untouched', () => {
    const service = build({ 'rateLimit.maxRequests': 100, 'rateLimit.windowMs': 60_000 }, { [TENANT_A]: { 'rateLimit.maxRequests': 5 } });

    // Tenant A gets its own number, and the source says WHY (§9.2 L8) — which
    // is what puts it ahead of the plan tier in the throttler's chain.
    expect(service.getTierForTenant('default', TENANT_A)).toMatchObject({ limit: 5, ttl: 60_000, limitSource: 'tenant' });
    expect(service.getTierForTenant('default', TENANT_B)).toMatchObject({ limit: 100, ttl: 60_000, limitSource: 'system' });
    // …and an anonymous / pre-token request rides the platform value.
    expect(service.getTierForTenant('default', null)).toMatchObject({ limit: 100, ttl: 60_000, limitSource: 'system' });
  });

  it('lets a tenant lengthen its own window (stricter) but not shorten it', () => {
    const strict = build({ 'rateLimit.windowMs': 60_000 }, { [TENANT_A]: { 'rateLimit.windowMs': 300_000 } });
    expect(strict.getTierForTenant('default', TENANT_A).ttl).toBe(300_000);

    const loosened = build({ 'rateLimit.windowMs': 60_000 }, { [TENANT_A]: { 'rateLimit.windowMs': 1 } });
    expect(loosened.getTierForTenant('default', TENANT_A).ttl).toBe(60_000);
  });

  it('clamps a tenant that tries to raise its limit above the platform value', () => {
    const service = build({ 'rateLimit.maxRequests': 100 }, { [TENANT_A]: { 'rateLimit.maxRequests': 100_000 } });
    expect(service.getTierForTenant('default', TENANT_A).limit).toBe(100);
  });

  it('clamps a tenant to its PLAN entitlement (§9.3 M2)', () => {
    const service = build({ 'rateLimit.maxRequests': 1000 }, { [TENANT_A]: { 'rateLimit.maxRequests': 900 } });
    expect(service.getTierForTenant('default', TENANT_A, { entitlement: 60 }).limit).toBe(60);
    // Within plan → untouched.
    expect(service.getTierForTenant('default', TENANT_A, { entitlement: 5000 }).limit).toBe(900);
  });

  it('falls back to the code baseline when nothing is stored anywhere', () => {
    const service = build();
    // `code-default` on both, so the throttler leaves them at the END of its
    // precedence chain and a per-tenant PLAN limit still applies.
    expect(service.getTierForTenant('default', TENANT_A)).toEqual({
      ...RATE_LIMIT_TIER_DEFAULTS.default,
      limitSource: 'code-default',
      ttlSource: 'code-default',
    });
  });

  it('leaves the NON-default tiers platform-wide (they are a safety property, not a plan feature)', () => {
    const service = build(
      { 'rate-limit.tier.strict.limit': 7 },
      // A planted tenant row must not govern a tier the descriptor caps at system scope.
      { [TENANT_A]: { 'rateLimit.maxRequests': 5 } },
    );
    expect(service.getTierForTenant('strict', TENANT_A)).toMatchObject({ limit: 7, ttl: RATE_LIMIT_TIER_DEFAULTS.strict.ttl });
  });
});

describe('RateLimitSettingsService — per-tenant kill-switch polarity', () => {
  it('lets a tenant switch throttling ON for itself when the platform has it OFF', () => {
    const service = build({ 'rateLimit.enabled': false }, { [TENANT_A]: { 'rateLimit.enabled': true } });
    expect(service.isEnabledForTenant(TENANT_A)).toBe(true);
    expect(service.isEnabledForTenant(TENANT_B)).toBe(false);
  });

  it('refuses to let a tenant switch OFF a protection the platform has ON', () => {
    const service = build({ 'rateLimit.enabled': true }, { [TENANT_A]: { 'rateLimit.enabled': false } });
    expect(service.isEnabledForTenant(TENANT_A)).toBe(true);
  });

  it('keeps the platform-wide `rate-limit.enabled` master switch authoritative', () => {
    // The pre-existing platform key still wins: it is the operator's global
    // off-switch and is not part of the tenant lane.
    const service = build({ 'rate-limit.enabled': false });
    expect(service.isEnabled()).toBe(false);
    expect(service.isEnabledForTenant(TENANT_A)).toBe(false);
  });
});
