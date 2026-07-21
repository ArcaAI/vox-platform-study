import { EntityId } from '@arcaai/domains';
import {
  EntitlementCapabilitiesResponse,
  PlanEntitlementResponse,
  TenantEntitlementResponse,
  UpdatePlanEntitlementRequest,
  UpsertTenantEntitlementRequest,
} from './dto';
import { ResolvedEntitlements } from './resolve-entitlements';
import { EntitlementLimitKey, MeterCapabilityKey } from './enforcement';

/**
 * Result of a storage soft-warn evaluation (Q6). `warn` is true when the
 * projected usage crosses the tenant's storage quota. Never blocks — the caller
 * proceeds regardless; this is a telemetry/notification signal.
 */
export interface StorageSoftWarn {
  warn: boolean;
  quotaBytes: number | null;
  usedBytes: number;
  projectedBytes: number;
}

/**
 * A tenant's resolved rate-limit policy for the hot-path
 * throttler: the plan's `rateLimitTier` name plus the optional per-tenant
 * absolute override (`rateLimitPerMinute`, "increase on demand"). `null` from
 * the resolver means "apply the global tiers unchanged" (kill-switch OFF or an
 * ungated null-plan/system tenant).
 */
export interface TenantRateLimitPolicy {
  tier: string;
  perMinute: number | null;
}

/**
 * The plan-entitlements service contract.
 *
 * Surfaces resolution + display, plus enforcement: the DB-backed
 * resolver (`PlanEntitlement` matrix ← per-tenant override, seeded fallback),
 * the read-only capability/usage snapshot, the global kill-switch accessor,
 * admin-editable CRUD over the matrix + overrides, per-service quota checks,
 * and rate-limit/model wiring, all layered on top of the same resolver.
 */
export interface IEntitlementsService {
  /**
   * Global enforcement kill-switch (`entitlements.enabled`, proposal Q9).
   * Ships OFF; read on every hot check so a flip is live cache-refresh fast.
   */
  isEnforcementEnabled(): boolean;

  /**
   * Flip the enforcement kill-switch and force an `AppSettingsService` cache
   * refresh so the new value is live for subsequent requests. GLOBAL_ADMIN-gated
   * at the HTTP layer; used by the enforcement-ON E2E to toggle in-test.
   */
  setEnforcementEnabled(enabled: boolean): Promise<boolean>;

  /**
   * Resolve the fully-merged entitlements for a tenant: seeded defaults ← DB
   * plan row ← per-tenant override. A `null`-plan tenant (incl. the system
   * tenant) resolves to ungated-legacy (Q3).
   */
  resolveForTenant(tenantId: EntityId): Promise<ResolvedEntitlements>;

  /**
   * The read-only capability/usage snapshot: resolved limits composed with live
   * usage from `getUsageStats` (+ API-key count) and live rolling-monthly meter
   * usage (Q5), features, tiers, and the trial clock.
   */
  getCapabilities(tenantId: EntityId): Promise<EntitlementCapabilitiesResponse>;

  /**
   * (Q10 "block-new") — throw a typed `QuotaExceededException` when
   * creating `increment` (default 1) more of a QUANTITY/meter `capability` would
   * exceed the tenant's resolved limit. A no-op when the enforcement kill-switch
   * is OFF (Q9) or the capability is unlimited (null limit, incl. ungated-legacy
   * Q3), so it is always safe to call from a create/submit path. The caller
   * supplies `currentCount` (it already holds the relevant repository/meter).
   * Existing resources are grandfathered — this blocks the NEW action only.
   */
  assertQuantityQuota(tenantId: EntityId, capability: EntitlementLimitKey, currentCount: number, increment?: number): Promise<void>;

  /**
   * (Q5 meters) — throw `QuotaExceededException` (→ 429) when performing
   * `increment` more of a rolling-monthly METER `capability` (consultations /
   * transcription-minutes / summaries) would exceed the tenant's monthly limit.
   * Reads the live current-month usage internally (no caller-supplied count).
   * A no-op when the kill-switch is OFF (Q9) or the meter is unlimited (Q3).
   */
  assertMeterQuota(tenantId: EntityId, capability: MeterCapabilityKey, increment?: number): Promise<void>;

  /**
   * The tenant's effective rate-limit policy for the pre-auth
   * throttler hot path (plan `rateLimitTier` + per-tenant `rateLimitPerMinute`
   * override). Returns `null` when the kill-switch is OFF or the tenant is
   * ungated (null-plan / system, Q3) — the guard then applies the global tiers
   * unchanged. Cached per tenant with a short TTL so the throttler stays O(1) on
   * the hot path; a bad/unknown tenantId (e.g. from an unverified token) resolves
   * to `null` rather than throwing.
   */
  getTenantRateLimitPolicy(tenantId: EntityId): Promise<TenantRateLimitPolicy | null>;

  /**
   * (concurrency) — HARD-BLOCK a new STT streaming session/consultation
   * when the tenant's live simultaneous-session count (from the multi-instance
   * socket-registry) is at/over its resolved `maxConcurrentSessions`. Throws a
   * typed `QuotaExceededException` (→ 429) and emits a block event. A no-op when
   * the kill-switch is OFF (Q9) or concurrency is unlimited (null limit, incl.
   * null-plan / system tenant, Q3). The live count is read internally; a Redis
   * blip fails OPEN (counts as 0) so infra hiccups never wrongly reject traffic.
   */
  assertConcurrencyQuota(tenantId: EntityId, increment?: number): Promise<void>;

  /**
   * (Q6 storage) — SOFT-WARN on the upload path: emit a warning event
   * (never blocks) when `additionalBytes` would push the tenant over its storage
   * quota. Returns the projected figures for the caller to surface. A no-op
   * (returns `warn:false`) when the kill-switch is OFF or storage is unlimited.
   */
  evaluateStorageSoftWarn(tenantId: EntityId, additionalBytes?: number): Promise<StorageSoftWarn>;

  /** List all seeded per-plan default rows (the matrix). */
  listPlanEntitlements(): Promise<PlanEntitlementResponse[]>;

  /** Fetch a single plan's default row; 404 when not seeded. */
  getPlanEntitlement(plan: string): Promise<PlanEntitlementResponse>;

  /** Super-admin edit of a plan's default row (OCC via `expectedVersion`). */
  updatePlanEntitlement(plan: string, request: UpdatePlanEntitlementRequest): Promise<PlanEntitlementResponse>;

  /** Fetch a tenant's override row; `null` when the tenant inherits the plan. */
  getTenantEntitlement(tenantId: EntityId): Promise<TenantEntitlementResponse | null>;

  /**
   * Create-or-update a tenant's override ("increase on demand", Q7).
   * `expectedVersion` is REQUIRED to update an existing row, ignored on create.
   */
  upsertTenantEntitlement(tenantId: EntityId, request: UpsertTenantEntitlementRequest): Promise<TenantEntitlementResponse>;

  /**
   * Clear a tenant's override back to full plan inheritance (nulls every
   * override field; the row is retained and reversible — never deleted).
   */
  clearTenantEntitlement(tenantId: EntityId): Promise<void>;
}

export const IEntitlementsService = Symbol('IEntitlementsService');
