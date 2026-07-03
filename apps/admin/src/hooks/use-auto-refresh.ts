import { useArcaStore } from '@arcaai/vox';
import { useCallback, useEffect, useRef } from 'react';
import { getTokenExpiryMs, isTokenExpired, registerOnTokenRefreshed, tryRefreshToken, unregisterOnTokenRefreshed } from '@/lib/auth-refresh';
import { useAuthStore } from '@/store/auth-store';

/** Refresh once 80% of the token lifetime has elapsed, never sooner than 30s. */
const REFRESH_THRESHOLD = 0.8;
const MIN_REFRESH_MS = 30_000;

/**
 * Wires the SDK's 401 interceptor to the admin auth store and schedules a
 * proactive refresh before token expiry (TASK-374).
 *
 * Both paths converge on `tryRefreshToken()` (which has a built-in mutex). On
 * success, the registered listener pushes the fresh access token into the SDK
 * client so every in-flight/next request uses it immediately — surviving hard
 * reloads where the SDK's in-memory refresh token would otherwise be lost.
 *
 * Must render inside `<AgenticProvider>` so `useArcaStore()` resolves.
 */
export function useAutoRefresh(): void {
  const apiClient = useArcaStore((s) => s.apiClient);
  const accessToken = useAuthStore((s) => s.accessToken);

  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;

  const handleUnauthorized = useCallback((): Promise<boolean> => tryRefreshToken(), []);

  useEffect(() => {
    if (!apiClient) return;

    const syncListener = (newToken: string) => {
      apiClientRef.current?.updateAccessToken(newToken);
    };

    registerOnTokenRefreshed(syncListener);
    apiClient.setOnUnauthorized(handleUnauthorized);

    return () => unregisterOnTokenRefreshed(syncListener);
  }, [apiClient, handleUnauthorized]);

  useEffect(() => {
    if (!accessToken) return;

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
    if (expiryMs <= 0) return;

    const refreshAt = Math.max(expiryMs * REFRESH_THRESHOLD, MIN_REFRESH_MS);
    const timerId = setTimeout(() => {
      void tryRefreshToken();
    }, refreshAt);

    return () => clearTimeout(timerId);
  }, [accessToken]);
}
