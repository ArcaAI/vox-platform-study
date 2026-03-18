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
}

export interface ImpersonateResponse {
  user: AuthUser & { tenantId?: string };
  token: string;
  impersonatedBy: string;
}
