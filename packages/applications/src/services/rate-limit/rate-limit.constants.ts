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

// ---------------------------------------------------------------------------
// The PER-PRINCIPAL lane (TASK-993 OD-2)
// ---------------------------------------------------------------------------

/**
 * How {@link RATE_LIMIT_PRINCIPAL_DEFAULTS} is derived, kept next to the number
 * so the two cannot drift apart (the shape `PLAN_RATE_LIMIT_SIZING` established
 * for the tenant AGGREGATE ceiling, whose measurements this reuses verbatim
 * rather than re-stating).
 *
 * ## What this limit is FOR
 *
 * OD-2 replaced "one tenant-wide counter" with **two levels**: a per-principal
 * bucket UNDERNEATH the tenant-wide aggregate ceiling. The aggregate answers
 * *"how much throughput did this tenant buy?"*; this one answers *"how much of
 * it may ONE caller take?"* — a runaway browser tab, a looping integration or
 * a stuck poller must not starve the other 99 doctors on the same tenant.
 *
 * ## Why it does NOT scale with the plan
 *
 * Every rate below is a property of a HUMAN driving the console, measured by
 * Playwright against a running gateway. A doctor's browser does not become
 * hungrier because the tenant upgraded its plan, so this number is the same on
 * STARTER and on ENTERPRISE. That is also why it is not an entitlement: an
 * entitlement prices what a tenant BUYS, and nobody buys "my own users may
 * each hammer me harder".
 *
 * ## The arithmetic
 *
 *   model : 26.0 req/min (measured ACTIVE user) x 3 headroom = 78.0
 *   floor : 44.1 req/min (measured WORST-CASE walk — every step a full
 *           document load) x 3 headroom                      = 132.3
 *   => max = 132.3, rounded UP to the nearest 50             = 150
 *
 * Unlike the plan aggregate, the worst-case branch here carries the SAME 3x
 * headroom as the model branch. That is deliberate and it is the one place the
 * two derivations differ: the plan's floor is an aggregate pathological case
 * ("every seat at once"), while this floor is a rate a single REAL user was
 * measured producing — set the limit at 44.1 and a doctor doing a legitimate
 * document-load walk is refused.
 *
 * Sanity, against lane D's shipped ceilings: on ENTERPRISE (150 seats,
 * 6,650/min) one principal can take at most 2.3% of the tenant's budget; on
 * STARTER (5 seats, 250/min) at most 60% — still never 100%, which is the
 * property this lane exists to create.
 */
export const RATE_LIMIT_PRINCIPAL_SIZING = {
  /** Measured: a clinically active console user (`PLAN_RATE_LIMIT_SIZING.MEASURED_ACTIVE_REQ_PER_MINUTE`). */
  MEASURED_ACTIVE_REQ_PER_MINUTE: 26.0,
  /** Measured: the all-document-load walk (`PLAN_RATE_LIMIT_SIZING.MEASURED_WORST_CASE_REQ_PER_MINUTE`). */
  MEASURED_WORST_CASE_REQ_PER_MINUTE: 44.1,
  /** Multiplier over the measured rate (owner decision OD-1: 3x, then load-test). */
  HEADROOM: 3,
  /** Rounding step, so the shipped number is legible in an admin UI. */
  ROUND_TO: 50,
} as const;

/** The derivation itself, so a test can re-run it rather than transcribe 150. */
export const principalLimitPerMinute = (): number => {
  const worst = Math.max(RATE_LIMIT_PRINCIPAL_SIZING.MEASURED_ACTIVE_REQ_PER_MINUTE, RATE_LIMIT_PRINCIPAL_SIZING.MEASURED_WORST_CASE_REQ_PER_MINUTE);
  const sized = worst * RATE_LIMIT_PRINCIPAL_SIZING.HEADROOM;
  return Math.ceil(sized / RATE_LIMIT_PRINCIPAL_SIZING.ROUND_TO) * RATE_LIMIT_PRINCIPAL_SIZING.ROUND_TO;
};

/**
 * Code baseline for the per-principal lane, used when no `GlobalSetting` row
 * exists — the same fallback contract every other value in this file has.
 *
 * The window is the tier window (60 s) and is deliberately NOT varied: a
 * window changed without changing the count it bounds reads to an admin as a
 * limit change nobody asked for.
 */
export const RATE_LIMIT_PRINCIPAL_DEFAULTS: RateLimitTierValue = {
  limit: principalLimitPerMinute(),
  ttl: RATE_LIMIT_TIER_DEFAULTS.default.ttl,
};

/** Default for the per-principal lane's own switch when the row is unset. */
export const RATE_LIMIT_PRINCIPAL_ENABLED_DEFAULT = true;

export const rateLimitPrincipalEnabledKey = (): string => `${RATE_LIMIT_NAMESPACE}.principal.enabled`;
export const rateLimitPrincipalLimitKey = (): string => `${RATE_LIMIT_NAMESPACE}.principal.limit`;
export const rateLimitPrincipalTtlKey = (): string => `${RATE_LIMIT_NAMESPACE}.principal.ttl`;
