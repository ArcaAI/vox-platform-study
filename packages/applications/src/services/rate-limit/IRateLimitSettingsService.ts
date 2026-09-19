import type { SettingSourceScope } from '../settings-registry/tenant-settings.service';
import { RateLimitTierName, RateLimitTierValue } from './rate-limit.constants';

/**
 * A tier resolved for one tenant, carrying WHICH cascade tier supplied each
 * number (every fallback is observable). The caller needs that to place the value correctly in the
 * throttler's precedence chain: a value that came from the TENANT's own row
 * outranks the tenant's plan tier (the tenant deliberately throttled itself
 * harder), while a value that merely fell through to the platform row or the
 * code baseline must NOT — otherwise a per-tenant plan limit would never apply.
 */
export interface TenantRateLimitTierValue extends RateLimitTierValue {
  limitSource: SettingSourceScope;
  ttlSource: SettingSourceScope;
}

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
 * The per-principal bucket's resolved policy (TASK-993 OD-2).
 *
 * `enabled === false` removes the second level entirely and restores the
 * single tenant-wide counter — the operator escape hatch for a lane that, by
 * design, can refuse a request the previous build allowed.
 */
export interface RateLimitPrincipalPolicy extends RateLimitTierValue {
  enabled: boolean;
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
   * The kill-switch as seen by ONE tenant.
   *
   * The platform-wide `rate-limit.enabled` master switch stays authoritative:
   * when an operator turns throttling off globally it is off, full stop. On top
   * of that a tenant may switch throttling ON for itself — but never off, since
   * `tenant-clamp.ts` declares this knob `true-is-stricter`.
   */
  isEnabledForTenant(tenantId: string | null): boolean;

  /**
   * The effective `{ limit, ttl }` for a tier as seen by ONE tenant
   * the cascade `tenant → SYSTEM → code baseline` with the
   * tenant clamp and the plan ceiling applied.
   *
   * Only the always-on `default` tier has a tenant lane; the opt-in
   * strict/heavy/relaxed tiers gate brute-force-sensitive routes and stay
   * platform-wide (their descriptors are `maxScope: 'system'`), so this returns
   * exactly `getTier(name)` for them.
   *
   * @param tenantId - the caller's tenant, or `null` for anonymous / pre-token
   *   traffic, which rides the platform values.
   * @param options.entitlement - the tenant's plan request ceiling, or
   *   `null`/omitted for unlimited (ungated tenants). Passed in by the caller
   *   because entitlement resolution already happens there.
   */
  getTierForTenant(name: RateLimitTierName, tenantId: string | null, options?: { entitlement?: number | null }): TenantRateLimitTierValue;

  /**
   * Per-endpoint override for a `routeId`, or `undefined` when the admin has
   * set none of the route's keys.
   */
  getRouteOverride(routeId: string): RateLimitRouteOverride | undefined;

  /**
   * The PER-PRINCIPAL lane (TASK-993 OD-2) — the second level of the two-level
   * bucketing model, read on every tenant-scoped request.
   *
   * Platform-wide by construction, exactly like the tier baselines and for the
   * same reason: the number is a property of how a HUMAN drives the console
   * (measured), not of what a tenant bought, so it does not vary by tenant or
   * by plan. A tenant that wants less throughput per caller already has
   * `rateLimit.maxRequests`, which tightens its whole aggregate.
   *
   * Never throws: an unreadable row degrades to the code baseline
   * (`failMode: 'open-to-default'`) — a bookkeeping failure must not refuse a
   * clinical request.
   */
  getPrincipalPolicy(): RateLimitPrincipalPolicy;

  /**
   * Whether a breach costs a FULL WINDOW of lockout from the moment it
   * happened (`true` — the pre-TASK-993 behaviour), or only the remainder of
   * the window it happened in (`false`, the shipped default).
   *
   * Platform-wide for the same reason the tier baselines are: it is a
   * PLATFORM SAFETY POSTURE, not something a tenant buys or tunes. Never
   * throws — an unreadable row degrades to the code default
   * (`failMode: 'open-to-default'`), and the code default is the more
   * forgiving of the two, so a bookkeeping failure can never invent a lockout.
   */
  isLockoutEnabled(): boolean;
}

export const IRateLimitSettingsService = Symbol('IRateLimitSettingsService');
