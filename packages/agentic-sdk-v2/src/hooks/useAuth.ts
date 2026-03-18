/**
 * @arcaai/vox - useAuth Hook (TASK-032 WS-A, TASK-209, TASK-224)
 *
 * JWT-based authentication hook with impersonation support.
 * Provides login, logout, token refresh, impersonate, and current user retrieval.
 */

import { useState, useMemo, useCallback } from 'react';
import { useAgenticStore } from '../store';
import { AUTH_ENDPOINTS } from '../core/constants';
import type { AuthUser, LoginResponse, ImpersonateResponse, RefreshTokenResponse } from '../types/auth';

const IMPERSONATION_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'] as const;

export interface UseAuthReturn {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: Error | null;
  impersonatedUser: AuthUser | null;
  isImpersonating: boolean;
  canImpersonate: boolean;
  login: (username: string, password: string, tenantKey?: string) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  getMe: () => Promise<AuthUser>;
  refreshToken: (refreshToken: string) => Promise<RefreshTokenResponse>;
  impersonate: (targetUserId: string) => Promise<ImpersonateResponse>;
  endImpersonation: () => Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child('useAuth'), [store.logger]);

  const user = (store.authUser as AuthUser | null) ?? null;
  const isAuthenticated = store.authIsAuthenticated;
  const impersonatedUser = (store.authImpersonatedUser as AuthUser | null) ?? null;
  const isImpersonating = impersonatedUser !== null;
  const canImpersonate = user?.roles?.some(
    (r) => (IMPERSONATION_ROLES as readonly string[]).includes(r),
  ) ?? false;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const login = useCallback(async (username: string, password: string, tenantKey?: string): Promise<LoginResponse> => {
    if (!apiClient) throw new Error('SDK not initialized');
    setIsLoading(true);
    setError(null);
    const timer = logger?.startOperation('login');
    try {
      const body: Record<string, string> = { username, password };
      if (tenantKey) body.tenantKey = tenantKey;
      const data = await apiClient.post<LoginResponse>(AUTH_ENDPOINTS.LOGIN, body);
      if (data.token) {
        apiClient.updateAccessToken(data.token);
      }
      store.setAuthUser(data.user);
      store.setIsAuthenticated(true);
      timer?.end(true);
      return data;
    } catch (err) {
      setError(err as Error);
      store.setIsAuthenticated(false);
      timer?.error(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, logger, store]);

  const logout = useCallback(async (): Promise<void> => {
    if (!apiClient) throw new Error('SDK not initialized');
    setIsLoading(true);
    setError(null);
    const timer = logger?.startOperation('logout');
    try {
      await apiClient.post(AUTH_ENDPOINTS.LOGOUT, {});
      apiClient.clearAccessToken();
      store.setAuthUser(null);
      store.setIsAuthenticated(false);
      store.setImpersonatedUser(null);
      store.setOriginalToken(null);
      store.setOriginalUser(null);
      timer?.end(true);
    } catch (err) {
      setError(err as Error);
      timer?.error(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, logger, store]);

  const getMe = useCallback(async (): Promise<AuthUser> => {
    if (!apiClient) throw new Error('SDK not initialized');
    setIsLoading(true);
    setError(null);
    const timer = logger?.startOperation('getMe');
    try {
      const data = await apiClient.get<AuthUser>(AUTH_ENDPOINTS.ME);
      store.setAuthUser(data);
      store.setIsAuthenticated(true);
      timer?.end(true);
      return data;
    } catch (err) {
      setError(err as Error);
      timer?.error(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, logger, store]);

  const refreshTokenFn = useCallback(async (currentRefreshToken: string): Promise<RefreshTokenResponse> => {
    if (!apiClient) throw new Error('SDK not initialized');
    setIsLoading(true);
    setError(null);
    const timer = logger?.startOperation('refreshToken');
    try {
      const data = await apiClient.post<RefreshTokenResponse>(AUTH_ENDPOINTS.REFRESH, { refreshToken: currentRefreshToken });
      if (data.token) {
        apiClient.updateAccessToken(data.token);
      }
      timer?.end(true);
      return data;
    } catch (err) {
      setError(err as Error);
      timer?.error(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, logger]);

  const impersonate = useCallback(async (targetUserId: string): Promise<ImpersonateResponse> => {
    if (!apiClient) throw new Error('SDK not initialized');
    setIsLoading(true);
    setError(null);
    const timer = logger?.startOperation('impersonate');
    try {
      const currentToken = apiClient.getAccessToken();
      const data = await apiClient.post<ImpersonateResponse>(AUTH_ENDPOINTS.IMPERSONATE, { targetUserId });

      store.setOriginalToken(currentToken ?? null);
      store.setOriginalUser(store.authUser);
      store.setImpersonatedUser(data.user);

      if (data.token) {
        apiClient.updateAccessToken(data.token);
      }

      timer?.end(true);
      return data;
    } catch (err) {
      setError(err as Error);
      timer?.error(err as Error);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, logger, store]);

  const endImpersonation = useCallback(async (): Promise<void> => {
    if (!apiClient) return;

    try {
      await apiClient.post(AUTH_ENDPOINTS.REVOKE_IMPERSONATION, {});
    } catch {
      logger?.warn('Failed to revoke impersonation token on server — proceeding with local cleanup');
    }

    const originalToken = store.authOriginalToken as string | null;
    const originalUser = store.authOriginalUser as AuthUser | null;

    if (originalToken) {
      apiClient.updateAccessToken(originalToken);
    }

    if (originalUser) {
      store.setAuthUser(originalUser);
    }

    store.setImpersonatedUser(null);
    store.setOriginalToken(null);
    store.setOriginalUser(null);
    logger?.info('Impersonation session ended, admin identity restored');
  }, [apiClient, store, logger]);

  return useMemo(() => ({
    user,
    isAuthenticated,
    isLoading,
    error,
    impersonatedUser,
    isImpersonating,
    canImpersonate,
    login,
    logout,
    getMe,
    refreshToken: refreshTokenFn,
    impersonate,
    endImpersonation,
  }), [user, isAuthenticated, isLoading, error, impersonatedUser, isImpersonating, canImpersonate, login, logout, getMe, refreshTokenFn, impersonate, endImpersonation]);
}
