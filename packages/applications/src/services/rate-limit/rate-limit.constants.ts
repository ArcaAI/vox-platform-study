/**
 * DB-backed, admin-controlled rate-limit configuration.
 *
 * Central registry of `GlobalSetting` keys, defaults, and the known set of
 * throttled API routes. Mirrors the `DYNAMIC_SCHEDULER_SETTINGS` registry used
 * by the scheduler admin service: every dynamically-tunable knob is declared
 * here so the read accessor, the admin service, the guard, and the seed all
 * reference the same literals.
 */

/** Namespace stamped on every rate-limit `GlobalSetting` row. */
export const RATE_LIMIT_NAMESPACE = 'rate-limit';

/**
 * Platform tenant that owns the single authoritative set of rate-limit rows.
 * Matches `AppSettingsService.PLATFORM_TENANT_IDS` (SYSTEM only — owner ruling
 * 2026-08-20) and the seed `SYSTEM_TENANT_ID`. NEVER the
 * GLOBAL/default tenant (`50000000-…`) — that id is a CUSTOMER tenant, never a
 * runtime tier.
 *
 * Rate limiting is a gateway-wide concern, so exactly one row exists per key.
 * The `AppSettingsService` cache is keyed by flat `key` across all tenants;
 * seeding a single platform row per key keeps that lookup deterministic and
 * avoids tripping the boot-time duplicate-key invariant.
 */
export const RATE_LIMIT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** The four named throttler tiers configured by `rate-limit-config.service.ts`. */
export type RateLimitTierName = 'default' | 'strict' | 'heavy' | 'relaxed';

export const RATE_LIMIT_TIERS: readonly RateLimitTierName[] = ['default', 'strict', 'heavy', 'relaxed'] as const;

export interface RateLimitTierValue {
  limit: number;
  ttl: number;
}

/**
 * Static tier baselines — the hardcoded fallback used when neither a DB row nor
 * a per-route `@Throttle` decorator supplies a value. Mirrors the throttler
 * definitions in `rate-limit-config.service.ts#getThrottlers()`.
 */
export const RATE_LIMIT_TIER_DEFAULTS: Record<RateLimitTierName, RateLimitTierValue> = {
  default: { limit: 100, ttl: 60000 },
  strict: { limit: 10, ttl: 60000 },
  heavy: { limit: 20, ttl: 60000 },
  relaxed: { limit: 300, ttl: 60000 },
};

/** Default for the global kill-switch when `rate-limit.enabled` is unset. */
export const RATE_LIMIT_GLOBAL_ENABLED_DEFAULT = true;

/**
 * A route that carries a `@Throttle` decorator today. `routeId` is the stable
 * slug used in the `rate-limit.route.<routeId>.*` keys and the admin API; the
 * guard maps a live request (controller class + handler name) onto it. The
 * `limit`/`ttl` mirror the decorator baseline so `getPolicy()` can report the
 * `code` source when no DB override is present.
 */
export interface KnownThrottledRoute {
  routeId: string;
  /** Controller class name as seen at runtime (`context.getClass().name`). */
  controller: string;
  /** Handler method name; omit for a controller-wide `@Throttle`. */
  handler?: string;
  tier: RateLimitTierName;
  limit: number;
  ttl: number;
  description: string;
}

export const KNOWN_THROTTLED_ROUTES: readonly KnownThrottledRoute[] = [
  {
    routeId: 'auth.login',
    controller: 'AuthController',
    handler: 'login',
    tier: 'default',
    limit: 5,
    ttl: 60000,
    description: 'Login (credential-stuffing bound)',
  },
  {
    routeId: 'auth.impersonate',
    controller: 'AuthController',
    handler: 'impersonate',
    tier: 'default',
    limit: 10,
    ttl: 60000,
    description: 'Admin impersonation',
  },
  { routeId: 'auth.refresh', controller: 'AuthController', handler: 'refresh', tier: 'default', limit: 60, ttl: 60000, description: 'Token refresh' },
  { routeId: 'health', controller: 'ApiHealthController', tier: 'default', limit: 30, ttl: 60000, description: 'Health probes' },
  { routeId: 'monitoring', controller: 'MonitoringController', tier: 'default', limit: 300, ttl: 60000, description: 'Monitoring endpoints' },
] as const;

// ---------------------------------------------------------------------------
// Key builders — the single source of truth for `rate-limit.*` GlobalSetting keys
// ---------------------------------------------------------------------------

export const rateLimitEnabledKey = (): string => `${RATE_LIMIT_NAMESPACE}.enabled`;
export const rateLimitTierLimitKey = (tier: RateLimitTierName): string => `${RATE_LIMIT_NAMESPACE}.tier.${tier}.limit`;
export const rateLimitTierTtlKey = (tier: RateLimitTierName): string => `${RATE_LIMIT_NAMESPACE}.tier.${tier}.ttl`;
export const rateLimitRouteLimitKey = (routeId: string): string => `${RATE_LIMIT_NAMESPACE}.route.${routeId}.limit`;
export const rateLimitRouteTtlKey = (routeId: string): string => `${RATE_LIMIT_NAMESPACE}.route.${routeId}.ttl`;
export const rateLimitRouteEnabledKey = (routeId: string): string => `${RATE_LIMIT_NAMESPACE}.route.${routeId}.enabled`;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export const isKnownTier = (name: string): name is RateLimitTierName => (RATE_LIMIT_TIERS as readonly string[]).includes(name);

export const findKnownRoute = (routeId: string): KnownThrottledRoute | undefined => KNOWN_THROTTLED_ROUTES.find((r) => r.routeId === routeId);

/**
 * Resolve a live request (controller class + handler name) to a known
 * `routeId`. Prefers an exact handler match, then a controller-wide match.
 * Returns `undefined` for routes that are not individually tunable.
 */
export const resolveRouteId = (controller: string, handler: string): string | undefined => {
  const byHandler = KNOWN_THROTTLED_ROUTES.find((r) => r.controller === controller && r.handler === handler);
  if (byHandler) return byHandler.routeId;
  const byController = KNOWN_THROTTLED_ROUTES.find((r) => r.controller === controller && r.handler === undefined);
  return byController?.routeId;
};
