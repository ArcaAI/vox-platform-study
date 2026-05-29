import { RateLimitTierName } from './rate-limit.constants';

/** Where an effective value came from. */
export type RateLimitValueSource = 'db' | 'code' | 'default';

export interface RateLimitTierPolicy {
  tier: RateLimitTierName;
  limit: number;
  ttl: number;
  /** `db` when an admin override exists, otherwise the static `default`. */
  limitSource: RateLimitValueSource;
  ttlSource: RateLimitValueSource;
}

export interface RateLimitRoutePolicy {
  routeId: string;
  controller: string;
  handler?: string;
  description: string;
  tier: RateLimitTierName;
  /** Effective limit/ttl after applying DB override over the decorator baseline. */
  limit: number;
  ttl: number;
  /** Effective per-route enabled flag (defaults to true). */
  enabled: boolean;
  limitSource: RateLimitValueSource;
  ttlSource: RateLimitValueSource;
}

export interface RateLimitPolicy {
  enabled: boolean;
  enabledSource: RateLimitValueSource;
  tiers: RateLimitTierPolicy[];
  routes: RateLimitRoutePolicy[];
}

export interface SetTierInput {
  limit?: number;
  ttl?: number;
}

export interface SetRouteInput {
  limit?: number;
  ttl?: number;
  enabled?: boolean;
}

/**
 * TASK-316 — admin write surface for rate-limit configuration. Each setter
 * persists a `rate-limit.*` `GlobalSetting` row via `IGlobalSettingService`,
 * then forces an `AppSettingsService.refreshCache()` so the change takes effect
 * for subsequent requests without a redeploy. Mirrors `SchedulerAdminService`.
 */
export interface IRateLimitAdminService {
  /** Effective policy: global flag + tier baselines + known-route overrides, with value sources. */
  getPolicy(): RateLimitPolicy;

  /** Flip the global kill-switch. */
  setEnabled(enabled: boolean): Promise<RateLimitPolicy>;

  /** Update a tier baseline (`limit` and/or `ttl`). */
  setTier(tier: string, input: SetTierInput): Promise<RateLimitPolicy>;

  /** Update a per-endpoint override (`limit`, `ttl`, and/or `enabled`). */
  setRoute(routeId: string, input: SetRouteInput): Promise<RateLimitPolicy>;
}

export const IRateLimitAdminService = Symbol('IRateLimitAdminService');
