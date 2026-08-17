/**
 * @arcaai/vox - Auth Types
 *
 * Types for JWT-based authentication.
 * Matches AuthController DTOs (LoginResponse, MeResponse, LogoutResponse, ImpersonateResponse).
 */

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
  /**
   * The user's primary department for the resolved
   * tenant. Carried through `/auth/me` and the `/auth/impersonate` response so
   * the SDK's department cascade (`AgenticProvider.effectiveDepartmentId`)
   * resolves the impersonated doctor's department tier instead of clearing it.
   */
  departmentId?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  tenantKey?: string;
}

export interface LoginResponse {
  user: AuthUser & { tenantId?: string; tenantKey?: string };
  token: string;
  refreshToken: string;
  /**
   * True when the password rotation window
   * (`security.password.maxAgeDays`) has been exceeded. Warning only: login
   * still succeeds; clients decide how to nudge. Absent when rotation is
   * disabled (default) or the password is within the window.
   */
  passwordExpired?: boolean;
}

export interface LogoutResponse {
  success: boolean;
  message: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface RefreshTokenResponse {
  token: string;
  refreshToken: string;
}

export interface ImpersonateRequest {
  targetUserId: string;
  /**
   * Optional tenant the (global) admin selected. When
   * present the backend impersonates the target within this tenant instead of
   * the target's oldest ENABLED assignment.
   */
  targetTenantId?: string;
}

export interface ImpersonateResponse {
  user: AuthUser & { tenantId?: string };
  token: string;
  impersonatedBy: string;
  /** ISO expiry of the time-boxed impersonation token (admin mint only). */
  expiresAt?: string;
  /** Seconds until expiry at mint time (admin mint only). */
  expiresInSeconds?: number;
}

/**
 * Options for the super-admin-only `useUsers().impersonate()` mint
 * (`POST /admin/users/:id/impersonate`). All optional; the reason is recorded
 * on the audit trail only (never embedded in the token).
 */
export interface AdminImpersonateOptions {
  reason?: string;
  targetTenantId?: string;
  /** TTL override in seconds (10–1800); intended for automated expiry tests. */
  expiresInSeconds?: number;
}
