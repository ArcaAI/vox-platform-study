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

import { ForbiddenException } from '@nestjs/common';
import type { SettingDescriptor } from './registry.types';

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

// ───────────────────── The tighten-only floor (reject, never clamp) ─────────

/**
 * Thrown when a tenant write would make a floor-guarded key LESS strict than
 * the platform value.
 *
 * A 403 — a PRIVILEGE boundary — deliberately NOT the 404-over-403 cross-tenant
 * posture (the caller unambiguously owns the row it is writing), and
 * deliberately NOT a silent clamp: an admin must be told their value was
 * refused rather than believing they set something they did not.
 *
 * This is the counterpart to `clampTenantSetting` above, and the two are NOT
 * redundant. The clamp narrows a value on READ, for knobs where quietly
 * enforcing the bound is the right answer (a rate limit). The floor refuses on
 * WRITE, for keys where a narrowed value would be a safety decision the tenant
 * never made (a detection threshold, a PII label taxonomy).
 */
export class SettingFloorViolation extends ForbiddenException {
  constructor(
    public readonly key: string,
    public readonly requested: unknown,
    public readonly floor: unknown,
  ) {
    super(
      `Setting '${key}' may only be tightened relative to the platform value. ` +
        `Requested ${JSON.stringify(requested)} is weaker than the floor ${JSON.stringify(floor)}.`,
    );
  }
}

/**
 * Enforce a descriptor's declared tighten-only floor for ONE write.
 *
 * DESCRIPTOR-DRIVEN, and that is the point: the direction is read off
 * `descriptor.floorDirection`, so this single call site covers every key that
 * declares one. The previous shape — a feature-specific `assert*Floor` carrying
 * its own private key table — was correct code that nothing ever invoked,
 * because wiring it required someone to remember its existence at the write
 * lane.
 *
 * A no-op when the descriptor declares no direction, or when the platform
 * supplies no floor to enforce against (an absent floor is "nothing to compare
 * to", not a spurious refusal). Never mutates or substitutes `requested`: on a
 * violation it throws, on success the caller writes exactly what was asked for.
 */
export function assertTightenOnlyFloor(descriptor: SettingDescriptor, requested: unknown, floor: unknown): void {
  const direction = descriptor.floorDirection;
  if (!direction) return;
  if (floor === null || floor === undefined) return;

  if (direction === 'superset-is-stricter') {
    // A tenant may ADD categories; it may never drop one the platform mandates.
    if (!Array.isArray(requested) || !Array.isArray(floor)) return;
    const missing = (floor as unknown[]).filter((entry) => !requested.includes(entry));
    if (missing.length > 0) {
      throw new SettingFloorViolation(descriptor.key, requested, floor);
    }
    return;
  }

  if (typeof requested !== 'number' || typeof floor !== 'number') return;

  if (direction === 'lower-is-stricter' && requested > floor) {
    throw new SettingFloorViolation(descriptor.key, requested, floor);
  }
  if (direction === 'higher-is-stricter' && requested < floor) {
    throw new SettingFloorViolation(descriptor.key, requested, floor);
  }
}
