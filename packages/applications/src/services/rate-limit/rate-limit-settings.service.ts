import { Inject, Injectable, Optional } from '@nestjs/common';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { IRateLimitSettingsService, RateLimitPrincipalPolicy, RateLimitRouteOverride, TenantRateLimitTierValue } from './IRateLimitSettingsService';
import {
  RATE_LIMIT_GLOBAL_ENABLED_DEFAULT,
  RATE_LIMIT_LOCKOUT_ENABLED_DEFAULT,
  RATE_LIMIT_PRINCIPAL_DEFAULTS,
  RATE_LIMIT_PRINCIPAL_ENABLED_DEFAULT,
  RATE_LIMIT_TIER_DEFAULTS,
  RateLimitTierName,
  RateLimitTierValue,
  rateLimitEnabledKey,
  rateLimitLockoutEnabledKey,
  rateLimitPrincipalEnabledKey,
  rateLimitPrincipalLimitKey,
  rateLimitPrincipalTtlKey,
  rateLimitRouteEnabledKey,
  rateLimitRouteLimitKey,
  rateLimitRouteTtlKey,
  rateLimitTierLimitKey,
  rateLimitTierTtlKey,
} from './rate-limit.constants';

/**
 * Read accessor over the rate-limit `GlobalSetting` rows.
 *
 * All reads are O(1) lookups against the `AppSettingsService` in-memory cache,
 * so calling this on the hot request path inside `TieredThrottlerGuard` adds
 * negligible overhead.
 */
@Injectable()
export class RateLimitSettingsService implements IRateLimitSettingsService {
  constructor(
    @Inject(IAppSettingsService)
    private readonly appSettings: IAppSettingsService,
    /**
     * The `global-kv` cascade. `@Optional()` so the graphs
     * that wire only this service — and the pre-existing unit tests — keep
     * their exact platform-only behaviour: without it, `*ForTenant` degrades
     * to the platform answer rather than failing.
     */
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  isEnabled(): boolean {
    return this.appSettings.getValueWithDefault<boolean>(rateLimitEnabledKey(), RATE_LIMIT_GLOBAL_ENABLED_DEFAULT);
  }

  getTier(name: RateLimitTierName): RateLimitTierValue {
    const fallback = RATE_LIMIT_TIER_DEFAULTS[name] ?? RATE_LIMIT_TIER_DEFAULTS.default;
    return {
      limit: this.appSettings.getValueWithDefault<number>(rateLimitTierLimitKey(name), fallback.limit),
      ttl: this.appSettings.getValueWithDefault<number>(rateLimitTierTtlKey(name), fallback.ttl),
    };
  }

  isEnabledForTenant(tenantId: string | null): boolean {
    // The platform master switch is authoritative and is NOT part of the tenant
    // lane: an operator turning throttling off globally must not be second-
    // guessed by a tenant row.
    if (!this.isEnabled()) return false;
    if (!this.tenantSettings) return true;
    return this.tenantSettings.resolve<boolean>('rateLimit.enabled', tenantId).value !== false;
  }

  getTierForTenant(name: RateLimitTierName, tenantId: string | null, options: { entitlement?: number | null } = {}): TenantRateLimitTierValue {
    // Only the always-on `default` tier is per-tenant — see the interface note.
    if (name !== 'default' || !this.tenantSettings) {
      return { ...this.getTier(name), limitSource: 'system', ttlSource: 'system' };
    }

    // The platform lane of `rateLimit.*` and the pre-existing
    // `rate-limit.tier.default.*` rows describe the SAME number by two key
    // grammars (the first is the migrated env baseline, the second the legacy
    // admin surface). `getTier` already resolves the legacy key with the code
    // baseline behind it, so it is the fallback here — which keeps every
    // already-written `rate-limit.tier.default.*` row authoritative and makes
    // this migration additive rather than a re-keying.
    const legacy = this.getTier(name);
    const limit = this.tenantSettings.resolve<number>('rateLimit.maxRequests', tenantId, {
      ...(options.entitlement === undefined ? {} : { entitlement: options.entitlement }),
    });
    const ttl = this.tenantSettings.resolve<number>('rateLimit.windowMs', tenantId);

    return {
      limit: limit.source === 'code-default' ? legacy.limit : limit.value,
      ttl: ttl.source === 'code-default' ? legacy.ttl : ttl.value,
      limitSource: limit.source,
      ttlSource: ttl.source,
    };
  }

  getPrincipalPolicy(): RateLimitPrincipalPolicy {
    // `getValueWithDefault` is the same O(1) cache read every other accessor
    // here uses, and it already answers the code baseline when the row is
    // absent — so a platform that has never seeded these keys gets the derived
    // number rather than an unbounded second lane.
    const limit = this.appSettings.getValueWithDefault<number>(rateLimitPrincipalLimitKey(), RATE_LIMIT_PRINCIPAL_DEFAULTS.limit);
    const ttl = this.appSettings.getValueWithDefault<number>(rateLimitPrincipalTtlKey(), RATE_LIMIT_PRINCIPAL_DEFAULTS.ttl);
    const enabled = this.appSettings.getValueWithDefault<boolean>(rateLimitPrincipalEnabledKey(), RATE_LIMIT_PRINCIPAL_ENABLED_DEFAULT);

    // A row written as 0, negative or non-finite would either refuse every
    // request or make the lane meaningless. Neither is a limit an admin can
    // have meant, so fall back rather than enforce it.
    const usable = Number.isFinite(limit) && limit > 0 && Number.isFinite(ttl) && ttl > 0;

    return usable
      ? { enabled: enabled !== false, limit, ttl }
      : { enabled: enabled !== false, limit: RATE_LIMIT_PRINCIPAL_DEFAULTS.limit, ttl: RATE_LIMIT_PRINCIPAL_DEFAULTS.ttl };
  }

  isLockoutEnabled(): boolean {
    // Same O(1) cache read as every other accessor here, and the same
    // absent-row contract: no row means the code default, which is OFF.
    return this.appSettings.getValueWithDefault<boolean>(rateLimitLockoutEnabledKey(), RATE_LIMIT_LOCKOUT_ENABLED_DEFAULT) === true;
  }

  getRouteOverride(routeId: string): RateLimitRouteOverride | undefined {
    const limitKey = rateLimitRouteLimitKey(routeId);
    const ttlKey = rateLimitRouteTtlKey(routeId);
    const enabledKey = rateLimitRouteEnabledKey(routeId);

    const hasLimit = this.appSettings.hasSetting(limitKey);
    const hasTtl = this.appSettings.hasSetting(ttlKey);
    const hasEnabled = this.appSettings.hasSetting(enabledKey);

    if (!hasLimit && !hasTtl && !hasEnabled) {
      return undefined;
    }

    return {
      limit: hasLimit ? this.appSettings.getValueFromCache(limitKey) : undefined,
      ttl: hasTtl ? this.appSettings.getValueFromCache(ttlKey) : undefined,
      enabled: hasEnabled ? this.appSettings.getValueFromCache(enabledKey) : undefined,
    };
  }
}
