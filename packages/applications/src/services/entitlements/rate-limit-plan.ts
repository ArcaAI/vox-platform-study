/**
 * TASK-392 (Q7) — plan → rate-limit composition.
 *
 * Pure helper that turns a tenant's resolved rate-limit tier + optional
 * per-tenant absolute override ("increase on demand") into a concrete
 * `{ limit, ttl }` using the DB-backed tier baseline. This is the primitive a
 * post-auth throttle hookup would call.
 *
 * NOTE (documented follow-up): the live `TieredThrottlerGuard` runs BEFORE auth
 * resolution (no CLS tenant context yet), so wiring per-tenant limits onto the
 * hot path needs the tenant extracted pre-auth (from the JWT) or a post-auth
 * throttle stage — an architectural change tracked as a TASK-392 follow-up. The
 * resolution + per-tenant override below are the source of truth for it.
 */

/** A tier baseline `{ limit, ttl }` (from `IRateLimitSettingsService.getTier`). */
export interface RateLimitTierBaseline {
  limit: number;
  ttl: number;
}

export interface EffectiveRateLimit {
  tier: string;
  limit: number;
  ttl: number;
  /** Which layer supplied the numeric limit. */
  source: 'per-tenant-override' | 'plan-tier';
}

/**
 * Q7 — resolve the effective rate-limit for a tenant. A non-null
 * `rateLimitPerMinute` (the per-tenant override) wins over the plan tier's
 * baseline limit; the window (`ttl`) always comes from the tier baseline.
 */
export function resolvePlanRateLimit(
  rateLimitTier: string,
  rateLimitPerMinute: number | null | undefined,
  tierBaseline: RateLimitTierBaseline,
): EffectiveRateLimit {
  if (rateLimitPerMinute !== null && rateLimitPerMinute !== undefined) {
    return { tier: rateLimitTier, limit: rateLimitPerMinute, ttl: tierBaseline.ttl, source: 'per-tenant-override' };
  }
  return { tier: rateLimitTier, limit: tierBaseline.limit, ttl: tierBaseline.ttl, source: 'plan-tier' };
}
