/**
 * AC-11 (TASK-336) — dedicated impersonation audit events.
 *
 * The legacy lifecycle audit reuses `EventTypes.UserAuthenticated` (discriminated
 * by a `phase` field) and is **success-only**. These dedicated, semantically
 * named events are emitted IN ADDITION so audit consumers can subscribe to a
 * precise impersonation signal — and, critically, observe DENIED attempts that
 * the success-only `UserAuthenticated` bracket never recorded.
 *
 * Plain string literals (not `EventTypes` enum members) are used on purpose:
 * EventEmitter2 dispatches on string names, so no `@arcaai/domains` enum
 * migration/rebuild is required to introduce these signals.
 */
export const ImpersonationEvents = {
  Started: 'impersonation.started',
  Ended: 'impersonation.ended',
  Denied: 'impersonation.denied',
} as const;

export type ImpersonationEventName = (typeof ImpersonationEvents)[keyof typeof ImpersonationEvents];

/**
 * Reasons an impersonation attempt is denied. Stable codes so consumers can
 * alert/aggregate on them without parsing free-text.
 */
export const ImpersonationDeniedReason = {
  CallerNotAdmin: 'CALLER_NOT_ADMIN',
  TargetIsSuperAdmin: 'TARGET_IS_SUPER_ADMIN',
  TenantAdminTargetNotAllowed: 'TENANT_ADMIN_TARGET_NOT_ALLOWED',
  CrossTenantDenied: 'CROSS_TENANT_DENIED',
  // TASK-401 — safeguards added with the super-admin-only endpoint (the first
  // two are also backported to the legacy /auth/impersonate route).
  SelfImpersonation: 'SELF_IMPERSONATION',
  NestedImpersonation: 'NESTED_IMPERSONATION',
  CallerNotSuperAdmin: 'CALLER_NOT_SUPER_ADMIN',
  TargetDisabled: 'TARGET_DISABLED',
} as const;

export type ImpersonationDeniedReasonCode = (typeof ImpersonationDeniedReason)[keyof typeof ImpersonationDeniedReason];

export interface ImpersonationEventPayload {
  /** The acting administrator (the impersonator). */
  adminId: string;
  /** The user being impersonated (or the attempted target on a denial). */
  targetUserId: string;
  /** Resolved impersonation tenant, when known. */
  tenantId?: string | null;
  /** `true` for Started/Ended, `false` for Denied. */
  success: boolean;
  /**
   * On Denied: an `ImpersonationDeniedReasonCode`.
   * On Started (TASK-401): the operator-entered free-text justification.
   */
  reason?: string;
  /** TASK-401 — ISO expiry of the minted impersonation token (Started only). */
  expiresAt?: string;
  endpoint: string;
  method: string;
  ip: string;
  userAgent: string;
  timestamp: Date;
}
