/**
 * @arcaai/vox - Auth Types (TASK-032 WS-A)
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
   * TASK-331 doc-05 F-9 — the user's primary department for the resolved
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
   * TASK-331 doc-05 F-3 — optional tenant the (global) admin selected. When
   * present the backend impersonates the target within this tenant instead of
   * the target's oldest ENABLED assignment.
   */
  targetTenantId?: string;
}

export interface ImpersonateResponse {
  user: AuthUser & { tenantId?: string };
  token: string;
  impersonatedBy: string;
}
