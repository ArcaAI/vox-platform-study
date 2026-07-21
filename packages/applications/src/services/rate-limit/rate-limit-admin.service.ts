import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ValueType } from '@arcaai/domains';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IGlobalSettingService } from '../globalSetting/IGlobalSettingService';
import {
  IRateLimitAdminService,
  RateLimitPolicy,
  RateLimitRoutePolicy,
  RateLimitTierPolicy,
  SetRouteInput,
  SetTierInput,
} from './IRateLimitAdminService';
import {
  KNOWN_THROTTLED_ROUTES,
  RATE_LIMIT_GLOBAL_ENABLED_DEFAULT,
  RATE_LIMIT_NAMESPACE,
  RATE_LIMIT_TENANT_ID,
  RATE_LIMIT_TIER_DEFAULTS,
  RATE_LIMIT_TIERS,
  RateLimitTierName,
  findKnownRoute,
  isKnownTier,
  rateLimitEnabledKey,
  rateLimitRouteEnabledKey,
  rateLimitRouteLimitKey,
  rateLimitRouteTtlKey,
  rateLimitTierLimitKey,
  rateLimitTierTtlKey,
} from './rate-limit.constants';

/**
 * Admin write service for DB-backed rate limiting.
 *
 * Writes go through `IGlobalSettingService` (the same path the GlobalSetting
 * admin CRUD uses). Platform `rate-limit.*` rows live under
 * `RATE_LIMIT_TENANT_ID`; a GLOBAL_ADMIN request resolves to a tenant-scope
 * pass-through (its CLS `tenantId` is undefined), so the cross-tenant
 * read/update behaves exactly like `TenantService.updateTenantConfigs`. The
 * HTTP layer additionally gates these endpoints to `manage all` (GLOBAL_ADMIN).
 *
 * After every write we force `AppSettingsService.refreshCache()` so the new
 * value is live for subsequent requests without a redeploy.
 */
@Injectable()
export class RateLimitAdminService implements IRateLimitAdminService {
  constructor(
    @Inject(IGlobalSettingService)
    private readonly globalSettings: IGlobalSettingService,
    @Inject(IAppSettingsService)
    private readonly appSettings: IAppSettingsService,
  ) {}

  getPolicy(): RateLimitPolicy {
    const enabledKey = rateLimitEnabledKey();
    const enabled = this.appSettings.getValueWithDefault<boolean>(enabledKey, RATE_LIMIT_GLOBAL_ENABLED_DEFAULT);

    const tiers: RateLimitTierPolicy[] = RATE_LIMIT_TIERS.map((tier) => {
      const fallback = RATE_LIMIT_TIER_DEFAULTS[tier];
      const limitKey = rateLimitTierLimitKey(tier);
      const ttlKey = rateLimitTierTtlKey(tier);
      return {
        tier,
        limit: this.appSettings.getValueWithDefault<number>(limitKey, fallback.limit),
        ttl: this.appSettings.getValueWithDefault<number>(ttlKey, fallback.ttl),
        limitSource: this.appSettings.hasSetting(limitKey) ? 'db' : 'default',
        ttlSource: this.appSettings.hasSetting(ttlKey) ? 'db' : 'default',
      };
    });

    const routes: RateLimitRoutePolicy[] = KNOWN_THROTTLED_ROUTES.map((route) => {
      const limitKey = rateLimitRouteLimitKey(route.routeId);
      const ttlKey = rateLimitRouteTtlKey(route.routeId);
      const enabledRouteKey = rateLimitRouteEnabledKey(route.routeId);
      const hasLimit = this.appSettings.hasSetting(limitKey);
      const hasTtl = this.appSettings.hasSetting(ttlKey);
      return {
        routeId: route.routeId,
        controller: route.controller,
        handler: route.handler,
        description: route.description,
        tier: route.tier,
        limit: hasLimit ? this.appSettings.getValueFromCache(limitKey) : route.limit,
        ttl: hasTtl ? this.appSettings.getValueFromCache(ttlKey) : route.ttl,
        enabled: this.appSettings.getValueWithDefault<boolean>(enabledRouteKey, true),
        limitSource: hasLimit ? 'db' : 'code',
        ttlSource: hasTtl ? 'db' : 'code',
      };
    });

    return {
      enabled,
      enabledSource: this.appSettings.hasSetting(enabledKey) ? 'db' : 'default',
      tiers,
      routes,
    };
  }

  async setEnabled(enabled: boolean): Promise<RateLimitPolicy> {
    await this.writeSetting(rateLimitEnabledKey(), String(Boolean(enabled)), ValueType.Boolean, 'Rate limit global kill-switch');
    return this.getPolicy();
  }

  async setTier(tier: string, input: SetTierInput): Promise<RateLimitPolicy> {
    if (!isKnownTier(tier)) {
      throw new BadRequestException(`Unknown rate-limit tier '${tier}'. Valid tiers: ${RATE_LIMIT_TIERS.join(', ')}.`);
    }
    if (input.limit === undefined && input.ttl === undefined) {
      throw new BadRequestException('At least one of `limit` or `ttl` must be provided.');
    }

    const name = tier as RateLimitTierName;
    if (input.limit !== undefined) {
      this.assertPositiveInt(input.limit, 'limit');
      await this.writeSetting(rateLimitTierLimitKey(name), String(input.limit), ValueType.Integer, `Rate limit tier '${name}' max requests`);
    }
    if (input.ttl !== undefined) {
      this.assertPositiveInt(input.ttl, 'ttl');
      await this.writeSetting(rateLimitTierTtlKey(name), String(input.ttl), ValueType.Integer, `Rate limit tier '${name}' window (ms)`);
    }
    return this.getPolicy();
  }

  async setRoute(routeId: string, input: SetRouteInput): Promise<RateLimitPolicy> {
    if (!findKnownRoute(routeId)) {
      throw new BadRequestException(`Unknown route '${routeId}'. Valid routes: ${KNOWN_THROTTLED_ROUTES.map((r) => r.routeId).join(', ')}.`);
    }
    if (input.limit === undefined && input.ttl === undefined && input.enabled === undefined) {
      throw new BadRequestException('At least one of `limit`, `ttl`, or `enabled` must be provided.');
    }

    if (input.limit !== undefined) {
      this.assertPositiveInt(input.limit, 'limit');
      await this.writeSetting(
        rateLimitRouteLimitKey(routeId),
        String(input.limit),
        ValueType.Integer,
        `Rate limit override for '${routeId}' max requests`,
      );
    }
    if (input.ttl !== undefined) {
      this.assertPositiveInt(input.ttl, 'ttl');
      await this.writeSetting(
        rateLimitRouteTtlKey(routeId),
        String(input.ttl),
        ValueType.Integer,
        `Rate limit override for '${routeId}' window (ms)`,
      );
    }
    if (input.enabled !== undefined) {
      await this.writeSetting(
        rateLimitRouteEnabledKey(routeId),
        String(Boolean(input.enabled)),
        ValueType.Boolean,
        `Rate limit toggle for '${routeId}'`,
      );
    }
    return this.getPolicy();
  }

  /**
   * Upsert a single `rate-limit.*` row, then refresh the cache. Resolves the
   * row id + optimistic-lock version from the cache (which always carries the
   * seeded platform row); creates the row if a deployment predates the seed.
   */
  private async writeSetting(key: string, value: string, dataType: ValueType, name: string): Promise<void> {
    const cached = this.appSettings.getFromCache(key);

    if (cached) {
      await this.globalSettings.update(cached.id, {
        value,
        expectedVersion: cached.version,
      });
    } else {
      await this.globalSettings.create({
        name,
        key,
        value,
        dataType,
        namespace: RATE_LIMIT_NAMESPACE,
        tenantId: RATE_LIMIT_TENANT_ID,
      });
    }

    await this.appSettings.refreshCache();
  }

  private assertPositiveInt(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new BadRequestException(`\`${field}\` must be a positive integer (received ${value}).`);
    }
  }
}
