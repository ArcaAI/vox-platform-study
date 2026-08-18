'use client';

import { useQuery } from '@tanstack/react-query';
import type { SafeSession } from '@/server/safe-user';
import type { PermissionRule } from '@/shared/auth/ability';

export type { SafeSession };

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Request to ${input} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/** Client hydration of the BFF session projection (never contains tokens). */
export function useSession() {
  return useQuery({
    queryKey: ['auth', 'session'],
    queryFn: () => fetchJson<SafeSession>('/api/auth/session'),
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
      const data = await fetchJson<MyPermissionsResponse>('/api/hope/users/me/permission-checks', { method: 'POST' });
      return data.permissions;
    },
    staleTime: 60_000,
  });
}
