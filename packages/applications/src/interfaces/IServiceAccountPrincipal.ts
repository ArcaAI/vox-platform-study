/**
 * The CLS principal for a service-account-authenticated request.
 *
 * A FIRST-CLASS principal, deliberately not a `UserSession` in disguise. Two
 * consequences the makes explicit and this shape encodes:
 *
 *  - `roles` is EXPLICIT and always present. `isSuperAdmin` (tenant-guards.ts)
 *    reads `user.roles`; the API-key path leaves it undefined, so every
 *    imperative super-admin check silently returns false for an API-key caller.
 *    A machine principal that inherited that would silently fail every
 *    super-admin-gated route, and one that populated it carelessly would
 *    silently become a super admin. Neither may happen by accident, so the
 *    guard derives it from the persisted `superAdmin` column and nothing else.
 *  - It lives under its OWN CLS key (`serviceAccount`), never under `user`.
 *    Overloading `user` would make every existing `requestUser?.id` read
 * attribute a machine action to a person — the defect
 *    exists to fix.
 */
export interface IServiceAccountPrincipal {
  /** `ServiceAccount.id` — the audit subject. */
  id: string;
  /** Public, non-secret client identifier. */
  clientId: string;
  /** The account's OWN tenant: a customer tenant, or SYSTEM for a platform account. */
  tenantId: string;
  /** The `svc:*` scopes the credential was issued with. */
  scopes: string[];
  /**
   * Derived from the persisted `superAdmin` column — never from a token claim
   * and never inferred. `isSuperAdmin` reads this array.
   */
  roles: string[];
  /** Platform accounts only: the working tenants this account may act on. */
  allowedTenantIds?: string[] | null;
  /** The tenant this REQUEST resolved to (may differ from `tenantId` for a platform account). */
  workingTenantId: string;
}
