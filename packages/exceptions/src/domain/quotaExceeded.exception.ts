import { QUOTA_EXCEEDED, BaseDomainException } from '../common';

/**
 * TASK-392 (Q10) — structured detail carried by a {@link QuotaExceededException}
 * so the API gateway can render a precise, machine-readable 409/429 body and the
 * admin console can point at the exact capability that blocked the action.
 */
export interface QuotaExceededMetadata {
  /** The capability key that was exceeded, e.g. `users`, `monthlyConsultations`. */
  capability: string;
  /** The resolved limit (null would be "unlimited", so it is never null here). */
  limit: number;
  /** The tenant's usage at the time of the block. */
  used: number;
  /** How many the blocked action attempted to add (default 1). */
  requested?: number;
  /** The tenant the block applied to. */
  tenantId?: string;
}

/**
 * TASK-392 (Q10, "block-new") — thrown by the entitlements quota precheck when
 * creating/submitting one more of a capability would exceed the tenant's
 * resolved plan limit. Only ever thrown when the enforcement kill-switch is ON
 * (Q9) and the tenant is gated (a concrete, non-null limit). Existing resources
 * are grandfathered — this blocks the NEW action only.
 */
export class QuotaExceededException extends BaseDomainException {
  static readonly code = QUOTA_EXCEEDED;
  constructor(message: string, metadata?: QuotaExceededMetadata, cause?: Error) {
    super(message, QuotaExceededException.code, cause, metadata);
  }
}
