import { RateLimitTierName, RateLimitTierValue } from './rate-limit.constants';

/**
 * A per-endpoint override read from the DB. Any field may be absent — only the
 * keys an admin has explicitly set are returned. `enabled === false` turns
 * throttling off for that route.
 */
export interface RateLimitRouteOverride {
  limit?: number;
  ttl?: number;
  enabled?: boolean;
}

/**
 * Read-only accessor over the rate-limit `GlobalSetting` rows,
 * resolved through the in-memory `AppSettingsService` cache (45s auto-refresh +
 * instant `refreshCache()`). A thin, typed analog of
 * `DnaRegenerationScheduler.getConfig()`.
 *
 * Every getter falls back to the static defaults in `rate-limit.constants.ts`
 * so the guard behaves identically to its pre-DB baseline when no rows exist.
 */
export interface IRateLimitSettingsService {
  /** Global kill-switch. Defaults to enabled when `rate-limit.enabled` is unset. */
  isEnabled(): boolean;

  /** Effective `{ limit, ttl }` for a tier — DB value or static default. */
  getTier(name: RateLimitTierName): RateLimitTierValue;

  /**
   * Per-endpoint override for a `routeId`, or `undefined` when the admin has
   * set none of the route's keys.
   */
  getRouteOverride(routeId: string): RateLimitRouteOverride | undefined;
}

export const IRateLimitSettingsService = Symbol('IRateLimitSettingsService');
