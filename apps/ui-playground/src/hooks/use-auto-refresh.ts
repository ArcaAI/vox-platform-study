import { getTokenExpiryMs, isTokenExpired, registerOnTokenRefreshed, tryRefreshToken, unregisterOnTokenRefreshed } from '@/lib/auth-refresh';
import { useAuthStore } from '@/store/auth-store';
import { useArcaStore, useAuth } from '@arcaai/vox';
import { useCallback, useEffect, useRef } from 'react';

const REFRESH_THRESHOLD = 0.8;
const MIN_REFRESH_MS = 30_000;
const AUTH_IMPERSONATE_ENDPOINT = '/auth/impersonate';

/**
 * Wires the SDK's 401 interceptor to the playground's auth store and
 * schedules proactive token refresh before expiry.
 *
 * All refresh paths (401 interceptor, proactive timer, admin-client,
 * smr-client) converge through tryRefreshToken() which has a built-in
 * mutex. After a successful refresh, registered listeners (including
 * AgenticClient.updateAccessToken) are notified so every HTTP client
 * uses the new token immediately.
 *
 * During impersonation, a 401 triggers a two-step recovery: first refresh
 * the base admin token, then re-impersonate the target user to get a fresh
 * impersonation token. If re-impersonation fails, impersonation ends and
 * the admin token is used instead.
 *
 * Must be rendered inside <AgenticProvider> so useAuth() and useArcaStore() resolve.
 */
export function useAutoRefresh(): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { refreshToken: _sdkRefreshToken } = useAuth();
  const apiClient = useArcaStore((s) => s.apiClient);
  const authMethod = useAuthStore((s) => s.authMethod);
  const accessToken = useAuthStore((s) => s.accessToken);

  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;

  const handleUnauthorized = useCallback(async (): Promise<boolean> => {
    const { isImpersonating, impersonatedUser } = useAuthStore.getState();

    if (!isImpersonating || !impersonatedUser) {
      return tryRefreshToken();
    }

    const baseRefreshed = await tryRefreshToken();
    if (!baseRefreshed) {
      return false;
    }

    const client = apiClientRef.current;
    if (!client) {
      return false;
    }

    const freshAdminToken = useAuthStore.getState().accessToken;
    client.updateAccessToken(freshAdminToken);

    try {
      // TASK-331 doc-05 F-3 — forward the active tenant so a global admin's
      // chosen tenant is honoured on re-impersonation (mirrors useAuth.impersonate).
      const currentTenantId = useAuthStore.getState().tenantId || undefined;
      const data = await client.post<{
        user: { id: string; tenantId?: string };
        token: string;
        impersonatedBy: string;
      }>(AUTH_IMPERSONATE_ENDPOINT, {
        targetUserId: impersonatedUser.id,
        ...(currentTenantId ? { targetTenantId: currentTenantId } : {}),
      });

      client.updateAccessToken(data.token);
      // TASK-331 doc-05 F-10 — trust the server-provided tenantId. TASK-295 M-5
      // removed the equivalent client-side `atob` JWT decode from user-list;
      // mirror that here (the backend always populates `user.tenantId`).
      const tenantId = data.user.tenantId;
      useAuthStore.getState().startImpersonation(impersonatedUser, data.token, tenantId);
      return true;
    } catch {
      // Re-impersonation failed: end impersonation and continue as the base
      // admin (whose token was just refreshed). This is a successful recovery
      // — the original request should be retried with the admin token — so
      // return true rather than forcing a logout.
      useAuthStore.getState().endImpersonation();
      client.updateAccessToken(freshAdminToken);
      return true;
    }
  }, []);

  useEffect(() => {
    if (authMethod !== 'credentials' || !apiClient) {
      return;
    }

    const syncListener = (newToken: string) => {
      const client = apiClientRef.current;
      if (!client) return;
      if (useAuthStore.getState().isImpersonating) {
        // TASK-340 — during impersonation the SDK client's accessToken holds
        // the impersonation JWT (must NOT be overwritten here), but admin-plane
        // requests are routed to the stashed admin JWT. Keep that stash fresh so
        // SDK-backed admin screens don't send a stale/expired admin token after
        // a refresh.
        client.updateImpersonationOriginalToken(newToken);
      } else {
        client.updateAccessToken(newToken);
      }
    };

    registerOnTokenRefreshed(syncListener);
    apiClient.setOnUnauthorized(handleUnauthorized);

    return () => {
      unregisterOnTokenRefreshed(syncListener);
    };
  }, [apiClient, authMethod, handleUnauthorized]);

  useEffect(() => {
    if (authMethod !== 'credentials' || !accessToken) {
      return;
    }

    if (isTokenExpired(accessToken)) {
      const { refreshToken } = useAuthStore.getState();
      if (refreshToken) {
        tryRefreshToken().then((ok) => {
          if (!ok) useAuthStore.getState().logout();
        });
      }
      return;
    }

    const expiryMs = getTokenExpiryMs(accessToken);
    if (expiryMs <= 0) {
      return;
    }

    const refreshAt = Math.max(expiryMs * REFRESH_THRESHOLD, MIN_REFRESH_MS);
    const timerId = setTimeout(() => {
      tryRefreshToken();
    }, refreshAt);

    return () => clearTimeout(timerId);
  }, [authMethod, accessToken]);
}
