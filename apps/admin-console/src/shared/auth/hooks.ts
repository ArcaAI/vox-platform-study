'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SafeSession } from '@/server/safe-user';
import { GatewayError, postJson } from '@/shared/api';
import type { PermissionRule } from '@/shared/auth/ability';
import { isPublicPath, redirectToLogin } from '@/shared/auth/session-expiry';

export type { SafeSession };

/**
 * The BFF session projection. Not a proxied call, so it goes around
 * `@/shared/api` — but it still throws a GatewayError, because a bare Error
 * is invisible to every 401-aware consumer (`isUnauthorized`, `retryQuery`).
 * Any 401 here IS expiry: this route has no step-up semantics to confuse it
 * with, unlike the /api/hope passthrough.
 */
async function fetchSession(): Promise<SafeSession> {
  const response = await fetch('/api/auth/session');
  if (!response.ok) {
    if (response.status === 401) redirectToLogin();
    throw new GatewayError(response.status, `Request to /api/auth/session failed with ${response.status}`);
  }
  return response.json() as Promise<SafeSession>;
}

/** Client hydration of the BFF session projection (never contains tokens). */
export function useSession() {
  return useQuery({
    queryKey: ['auth', 'session'],
    queryFn: fetchSession,
    staleTime: 60_000,
  });
}

interface MyPermissionsResponse {
  userId: string;
  tenantId: string | null;
  permissions: PermissionRule[];
}

/**
 * The caller's effective CASL rules from POST /users/me/permission-checks
 * (via the BFF proxy). Drives menu visibility and <RequirePermission>.
 */
export function usePermissions() {
  return useQuery({
    queryKey: ['auth', 'permissions'],
    queryFn: async () => {
      const data = await postJson<MyPermissionsResponse>('users/me/permission-checks');
      return data.permissions;
    },
    staleTime: 60_000,
  });
}

/**
 * Access tokens live for JWT_EXPIRES_IN (1h by default), and until TASK-988
 * nothing ever called the rotation route: an idle tab only discovered expiry
 * through a request that had already failed. Fifteen minutes rotates four
 * times inside that window — always well clear of the TTL, at one gateway
 * call per quarter hour.
 */
const HEARTBEAT_INTERVAL_MS = 15 * 60_000;

/**
 * Deliberately a bare interval and not a focus/visibility listener: refresh
 * tokens are single-use, so a fleet of tabs rotating on one focus event is
 * the stampede the gateway reads as token reuse.
 */
export function useSessionHeartbeat(): void {
  useEffect(() => {
    if (isPublicPath(window.location.pathname)) return;
    const timer = setInterval(() => {
      void fetch('/api/auth/refresh', { method: 'POST' }).then(
        (response) => {
          if (response.status === 401) redirectToLogin();
        },
        // A transient network failure is not expiry; the next tick retries.
        () => {},
      );
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
}
