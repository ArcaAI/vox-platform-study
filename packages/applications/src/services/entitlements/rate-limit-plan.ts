/**
 * Plan → rate-limit composition.
 *
 * Pure helper that turns a tenant's resolved rate-limit tier + optional
 * per-tenant absolute override ("increase on demand") into a concrete
 * `{ limit, ttl }` using the DB-backed tier baseline. This is the primitive a
 * post-auth throttle hookup would call.
 *
 * this is rank 3 of the five-level cascade in `rate-limit-resolver.ts`.
 * `TieredThrottlerGuard` still runs BEFORE auth, so the tenant reaching this
 * helper comes from a signature-VERIFIED bearer token; an unverifiable token
 * resolves no tenant and never reaches rank 3.
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
 * Resolve the effective rate limit a tenant's PLAN expresses (rank 3).
 *
 * Two layers, in increasing precedence:
 *   1. the named tier the plan selects — its baseline supplies both numbers;
 *   2. an ABSOLUTE `rateLimitPerMinute`, from the plan row or the per-tenant
 *      entitlement override, which replaces the count.
 *
 * `windowMs` is read ONLY alongside an absolute count. On its own it
 * would change the window without changing the count it bounds — which reads to
 * an admin as a limit change nobody asked for. Absent it, the window stays the
 * tier baseline's, preserving the earlier behaviour exactly.
 */
export function resolvePlanRateLimit(
  rateLimitTier: string,
  rateLimitPerMinute: number | null | undefined,
  tierBaseline: RateLimitTierBaseline,
  rateLimitWindowMs?: number | null,
): EffectiveRateLimit {
  if (rateLimitPerMinute !== null && rateLimitPerMinute !== undefined) {
    return {
      tier: rateLimitTier,
      limit: rateLimitPerMinute,
      ttl: rateLimitWindowMs ?? tierBaseline.ttl,
      source: 'per-tenant-override',
    };
  }
  return { tier: rateLimitTier, limit: tierBaseline.limit, ttl: tierBaseline.ttl, source: 'plan-tier' };
}
