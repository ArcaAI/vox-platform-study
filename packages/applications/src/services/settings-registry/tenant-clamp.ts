// The tenant-override clamp.
//
// THE RULE, stated once: a tenant override may only make a setting MORE
// RESTRICTIVE than the platform value, and may never exceed the tenant's plan
// entitlement. Entitlements BOUND what a tenant MAY set; they never supply a
// value (that is the deliberate improvement on the common 4-level pattern —
// entitlements stay a ceiling so a later contributor does not "fix" them
// into the cascade).
//
// WHY A DIRECTION TABLE RATHER THAN "tenant always wins".
// `maxScope: 'tenant'` on a SECURITY knob is only safe if the deeper scope
// cannot LOOSEN it. Without a clamp, a tenant admin could set its own
// `rateLimit.enabled = false`, or lengthen `apiKey.maxLifetimeDays` to a year —
// i.e. escalate by writing its own configuration row. Every knob this lane
// moved to `maxScope: 'tenant'` therefore declares which direction is stricter,
// and the resolver refuses the other one. There is no per-key `if` anywhere
// else in the codebase: this table is the whole policy.
//
// Kept PURE (no DI, no I/O) so the policy is exhaustively unit-testable and can
// be called from the resolver, the write lane, and a test with equal ease.

/** Which direction makes a tenant override stricter than the platform value. */
export type ClampDirection =
  /** Numeric knob where a SMALLER number is tighter (request limits, TTLs, lifetimes). */
  | 'lower-is-stricter'
  /** Numeric knob where a LARGER number is tighter (a rate-limit WINDOW: same requests, longer window). */
  | 'higher-is-stricter'
  /** Boolean PROTECTION that is tighter when ON (`rate-limit.enabled`). */
  | 'true-is-stricter'
  /** Boolean CAPABILITY that is tighter when OFF (a tenant may disable a feature its plan allows, never enable one it lacks). */
  | 'false-is-stricter';

/**
 * The clamp direction for every key this lane moved to `maxScope: 'tenant'`.
 *
 * A key ABSENT from this table has no tenant lane — either it is
 * `maxScope: 'system'` (platform-only) or it is still env-tier. A missing entry
 * therefore means "pass through", not "unclamped tenant override": the scope
 * clamp in `SettingsRegistry.assertWithinMaxScope` already refuses a tenant
 * write for those keys, so the two guards cannot disagree.
 */
export const TENANT_OVERRIDE_CLAMPS: Readonly<Record<string, ClampDirection>> = Object.freeze({
  // Requests allowed per window — a tenant may throttle itself harder.
  'rateLimit.maxRequests': 'lower-is-stricter',
  // Window length — a LONGER window over the same limit is a tighter budget.
  'rateLimit.windowMs': 'higher-is-stricter',
  // The throttler master switch is a PROTECTION: ON is strict.
  'rateLimit.enabled': 'true-is-stricter',
  // Credential lifetimes: shorter is tighter.
  'apiKey.maxLifetimeDays': 'lower-is-stricter',
  'refreshToken.ttlSeconds': 'lower-is-stricter',
});

export interface TenantClampBounds {
  /**
   * The value the PLATFORM lane resolved (SYSTEM row, else the descriptor
   * default). `null`/`undefined` means "the platform sets no bound" — for a
   * numeric knob that is UNLIMITED, which nothing a tenant sets can exceed.
   */
  platform?: unknown;
  /**
   * The tenant's plan ceiling for this key, when one exists. `null`/`undefined`
   * = unlimited (an ungated / null-plan tenant, Q3). Only numeric knobs with a
   * plan analogue ever receive one — today that is `rateLimit.maxRequests`,
   * bounded by the resolved `rateLimitPerMinute` / plan-tier limit.
   */
  entitlement?: number | null;
}

export interface TenantClampResult<T> {
  value: T;
  clamped: boolean;
  /** Which bound won. Present only when `clamped` is true — for the audit trail / WARN log. */
  bound?: 'platform' | 'entitlement';
}

/**
 * Apply the platform bound and the entitlement ceiling to one tenant override.
 *
 * Returns the value the tenant actually gets plus whether a bound bit, so the
 * caller can log the refusal (every fallback is observable) instead of
 * silently narrowing a value an admin believes they set.
 */
export function clampTenantSetting<T>(key: string, tenantValue: T, bounds: TenantClampBounds = {}): TenantClampResult<T> {
  const direction = TENANT_OVERRIDE_CLAMPS[key];
  if (!direction) {
    return { value: tenantValue, clamped: false };
  }

  if (direction === 'true-is-stricter' || direction === 'false-is-stricter') {
    const strict = direction === 'true-is-stricter';
    if (typeof tenantValue !== 'boolean' || typeof bounds.platform !== 'boolean') {
      return { value: tenantValue, clamped: false };
    }
    // The tenant may move the flag TOWARDS the strict end and nowhere else.
    if (tenantValue !== strict && bounds.platform === strict) {
      return { value: bounds.platform as T, clamped: true, bound: 'platform' };
    }
    return { value: tenantValue, clamped: false };
  }

  if (typeof tenantValue !== 'number' || !Number.isFinite(tenantValue)) {
    return { value: tenantValue, clamped: false };
  }

  // Collect the bounds that actually apply, then pick the one that binds first.
  const candidates: { limit: number; bound: 'platform' | 'entitlement' }[] = [];
  if (typeof bounds.platform === 'number' && Number.isFinite(bounds.platform)) {
    candidates.push({ limit: bounds.platform, bound: 'platform' });
  }
  // The entitlement ceiling is a MAXIMUM by construction ("what the plan
  // grants"), so it only participates in the lower-is-stricter direction.
  if (direction === 'lower-is-stricter' && typeof bounds.entitlement === 'number' && Number.isFinite(bounds.entitlement)) {
    candidates.push({ limit: bounds.entitlement, bound: 'entitlement' });
  }
  if (candidates.length === 0) {
    return { value: tenantValue, clamped: false };
  }

  if (direction === 'lower-is-stricter') {
    // The tightest ceiling wins; ties resolve to `entitlement` because a plan
    // bound is the more specific explanation to show an admin.
    const tightest = candidates.reduce((a, b) => (b.limit <= a.limit ? b : a));
    return tenantValue > tightest.limit
      ? { value: tightest.limit as T, clamped: true, bound: tightest.bound }
      : { value: tenantValue, clamped: false };
  }

  // higher-is-stricter: the platform value is a FLOOR the tenant may exceed.
  const floor = candidates.reduce((a, b) => (b.limit >= a.limit ? b : a));
  return tenantValue < floor.limit ? { value: floor.limit as T, clamped: true, bound: floor.bound } : { value: tenantValue, clamped: false };
}
