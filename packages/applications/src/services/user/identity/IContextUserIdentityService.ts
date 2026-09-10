// TASK-950 — the find-or-provision contract for a context-schema user identity.
//
// One entry point, called by all three service-account planes (plan D-6) AFTER each plane's own
// context validator has passed. It answers exactly one question: which HOPE `User` does this
// tenant's staff identifier name, creating one if policy allows and none exists.

/** DI token. Injected by the consultation-open, agent-invocation and workflow-run planes. */
export const IContextUserIdentityService = Symbol('IContextUserIdentityService');

/** Which plane asked. Recorded in the provisioned user's `_metadata` and in the sys-event. */
export type UserIdentityPlane = 'consultation-open' | 'agent-invocation' | 'workflow-run';

/**
 * Why a user exists, recorded on the row itself.
 *
 * A user minted by a machine has no human onboarding trail, so the row has to carry its own:
 * six months later "who is `auto_9f2c…` and why can they own consultations?" must be answerable
 * from the row, not from a log that has rolled over.
 */
export interface UserIdentityProvenance {
  plane: UserIdentityPlane;
  /** The STRUCTURED kind whose property carried the value. */
  kindKey: string;
  /** The property within that kind. */
  field: string;
  /** The service account that made the request — the ACTOR (plan D-11). */
  serviceAccountId: string;
  /** The schema version the binding came from, when the plane knows it. */
  schemaId?: string;
  versionNumber?: number;
}

export interface ResolveUserIdentityInput {
  tenantId: string;
  /** The RAW payload value. Normalisation (trim) and validation happen inside the service. */
  staffId: string;
  /** The request's department, when the plane has one. Wins over the tenant setting. */
  departmentId?: string | null;
  provenance: UserIdentityProvenance;
}

export interface ResolveUserIdentityResult {
  userId: string;
  /** True when THIS call created the user; false when it reused an existing one. */
  provisioned: boolean;
}

export interface IContextUserIdentityService {
  /**
   * Resolve a tenant staff identifier to a HOPE user id, provisioning one when policy allows.
   *
   * Refusals, all of them deliberate (plan D-10):
   *  · 400 `USER_IDENTITY_INVALID`                — empty / > 128 chars / control characters.
   *  · 404 `USER_IDENTITY_NOT_USABLE`             — matched a user that is not ENABLED.
   *  · 409 `USER_IDENTITY_AMBIGUOUS`              — matched more than one user.
   *  · 404 `USER_IDENTITY_UNKNOWN`                — no match and provisioning is off.
   *  · 400 `USER_IDENTITY_DEPARTMENT_UNRESOLVED`  — nothing supplied a department.
   *  · 403                                        — the configured role is `SUPER_ADMIN`.
   *  · 409 `QuotaExceededException`               — the tenant is out of `maxUsers` seats.
   *
   * The 404s are the house 404-over-403 posture for the user id space, not "route missing".
   */
  resolveOrProvision(input: ResolveUserIdentityInput): Promise<ResolveUserIdentityResult>;
}
