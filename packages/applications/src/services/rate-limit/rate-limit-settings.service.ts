import { Inject, Injectable } from '@nestjs/common';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IRateLimitSettingsService, RateLimitRouteOverride } from './IRateLimitSettingsService';
import {
  RATE_LIMIT_GLOBAL_ENABLED_DEFAULT,
  RATE_LIMIT_TIER_DEFAULTS,
  RateLimitTierName,
  RateLimitTierValue,
  rateLimitEnabledKey,
  rateLimitRouteEnabledKey,
  rateLimitRouteLimitKey,
  rateLimitRouteTtlKey,
  rateLimitTierLimitKey,
  rateLimitTierTtlKey,
} from './rate-limit.constants';

/**
 * TASK-316 — read accessor over the rate-limit `GlobalSetting` rows.
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
