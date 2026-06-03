/**
 * @arcaai/vox - useAuth Hook (TASK-032 WS-A, TASK-209, TASK-224, TASK-264)
 *
 * JWT-based authentication hook with impersonation support.
 * Provides login, logout, token refresh, impersonate, and current user retrieval.
 *
 * TASK-264 W0-3: the admin "original" JWT is no longer stored in the Zustand
 * store. It lives in a private WeakMap inside `AgenticClient` and is restored
 * via `apiClient.stopImpersonation()`. `useAuth` simply exposes the boolean
 * `isImpersonating` and proxies `startImpersonation` / `stopImpersonation`.
 */

import { useState, useMemo, useCallback } from 'react';
import { useAgenticStore } from '../store';
import { AUTH_ENDPOINTS } from '../core/constants';
import type { AuthUser, LoginResponse, ImpersonateRequest, ImpersonateResponse, RefreshTokenResponse } from '../types/auth';

// TASK-331 doc-05 F-4 — GLOBAL_ADMIN is a full SUPER_ADMIN synonym.
const IMPERSONATION_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'] as const;

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
  impersonate: (targetUserId: string, targetTenantId?: string) => Promise<ImpersonateResponse>;
  endImpersonation: () => Promise<void>;
  /**
   * Low-level escape hatch: stash an admin token explicitly. Most consumers
   * should use `impersonate()` instead, which performs the server round-trip
   * and wires this up. TASK-264 W0-3.
   */
  startImpersonation: (token: string) => void;
  /**
   * Low-level escape hatch: clear any active impersonation locally. Most
   * consumers should use `endImpersonation()` instead, which also restores
   * the admin user identity in the store. TASK-264 W0-3.
   */
  stopImpersonation: () => void;
}

export function useAuth(): UseAuthReturn {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child('useAuth'), [store.logger]);

  const user = (store.authUser as AuthUser | null) ?? null;
  const isAuthenticated = store.authIsAuthenticated;
  const impersonatedUser = (store.authImpersonatedUser as AuthUser | null) ?? null;
  // TASK-264 W0-3: impersonation flag now derived from BOTH the impersonated
  // user (UI cue) and the client's private flag (source of truth for the
  // admin token). They should agree, but the client flag is authoritative
  // because the admin JWT is no longer in the store.
  const isImpersonating = impersonatedUser !== null || (apiClient?.isImpersonating() ?? false);
  const canImpersonate = user?.roles?.some((r) => (IMPERSONATION_ROLES as readonly string[]).includes(r)) ?? false;
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const login = useCallback(
    async (username: string, password: string, tenantKey?: string): Promise<LoginResponse> => {
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
        // TASK-320 B2 — capture the refresh token in AgenticClient's in-memory
        // store so the auto-refresh handler (wired by AgenticProvider) can mint
        // a new access token on a 401 without the host app wiring anything.
        if (data.refreshToken) {
          apiClient.setRefreshToken(data.refreshToken);
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
    },
    [apiClient, logger, store],
  );

  const logout = useCallback(async (): Promise<void> => {
    if (!apiClient) throw new Error('SDK not initialized');
    setIsLoading(true);
    setError(null);
    const timer = logger?.startOperation('logout');
    try {
      await apiClient.post(AUTH_ENDPOINTS.LOGOUT, {});
      apiClient.clearAccessToken();
      // TASK-320 B2 — drop the in-memory refresh token so a logged-out client
      // can't auto-refresh back into an authenticated state.
      apiClient.clearRefreshToken();
      // TASK-264 W0-3: discard any stashed admin token defensively.
      if (apiClient.isImpersonating()) apiClient.stopImpersonation();
      store.setAuthUser(null);
      store.setIsAuthenticated(false);
      store.setImpersonatedUser(null);
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

  const refreshTokenFn = useCallback(
    async (currentRefreshToken: string): Promise<RefreshTokenResponse> => {
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
    },
    [apiClient, logger],
  );

  const impersonate = useCallback(
    async (targetUserId: string, targetTenantId?: string): Promise<ImpersonateResponse> => {
      if (!apiClient) throw new Error('SDK not initialized');
      setIsLoading(true);
      setError(null);
      const timer = logger?.startOperation('impersonate');
      try {
        const currentToken = apiClient.getAccessToken();
        // TASK-331 doc-05 F-3 — forward the caller's selected tenant so a global
        // admin's chosen tenant is honoured; without it the backend falls back
        // to the target's OLDEST assignment. Sent ONLY when provided.
        const body: ImpersonateRequest = { targetUserId };
        if (targetTenantId) body.targetTenantId = targetTenantId;
        const data = await apiClient.post<ImpersonateResponse>(AUTH_ENDPOINTS.IMPERSONATE, body);

        // TASK-264 W0-3: stash admin token inside AgenticClient (WeakMap),
        // not in the Zustand store. Only stash when we have a non-empty
        // token — `startImpersonation` rejects empty input.
        if (currentToken && currentToken.length > 0) {
          apiClient.startImpersonation(currentToken);
        }
        store.setOriginalUser(store.authUser);
        store.setImpersonatedUser(data.user);

        if (data.token) {
          apiClient.updateAccessToken(data.token);
        }

        // TASK-297 H-4 — gate PersonalizationManager so admin edits during
        // impersonation stay in-memory only (no IDB write, no PATCH).
        store.personalizationManager?.setImpersonationReadOnly?.(true);

        timer?.end(true);
        return data;
      } catch (err) {
        setError(err as Error);
        timer?.error(err as Error);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [apiClient, logger, store],
  );

  const endImpersonation = useCallback(async (): Promise<void> => {
    if (!apiClient) return;

    try {
      await apiClient.post(AUTH_ENDPOINTS.REVOKE_IMPERSONATION, {});
    } catch {
      logger?.warn('Failed to revoke impersonation token on server — proceeding with local cleanup');
    }

    // TASK-264 W0-3: retrieve and restore admin token from AgenticClient.
    const originalToken = apiClient.stopImpersonation();
    const originalUser = store.authOriginalUser as AuthUser | null;

    if (originalToken) {
      apiClient.updateAccessToken(originalToken);
    }

    if (originalUser) {
      store.setAuthUser(originalUser);
    }

    store.setImpersonatedUser(null);
    store.setOriginalUser(null);
    // TASK-297 H-4 — restore PersonalizationManager to read-write mode now
    // that the admin has resumed their own identity.
    store.personalizationManager?.setImpersonationReadOnly?.(false);
    logger?.info('Impersonation session ended, admin identity restored');
  }, [apiClient, store, logger]);

  // TASK-264 W0-3 — low-level escape hatches that proxy to AgenticClient.
  const startImpersonationFn = useCallback(
    (token: string): void => {
      if (!apiClient) throw new Error('SDK not initialized');
      apiClient.startImpersonation(token);
    },
    [apiClient],
  );

  const stopImpersonationFn = useCallback((): void => {
    if (!apiClient) return;
    apiClient.stopImpersonation();
  }, [apiClient]);

  return useMemo(
    () => ({
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
      startImpersonation: startImpersonationFn,
      stopImpersonation: stopImpersonationFn,
    }),
    [
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
      refreshTokenFn,
      impersonate,
      endImpersonation,
      startImpersonationFn,
      stopImpersonationFn,
    ],
  );
}
