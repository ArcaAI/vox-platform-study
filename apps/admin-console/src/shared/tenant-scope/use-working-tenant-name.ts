'use client';

import { useQuery } from '@tanstack/react-query';

interface TenantListItem {
  id: string;
  name: string;
}

/**
 * The working tenant's display name. The session usually carries it; when it does not, the tenant
 * list (same query key as the tenant switcher, so the cache is shared) supplies it. Never returns
 * the id: callers decide how to render an unresolved name.
 */
export function useWorkingTenantName(workingTenantId: string | null | undefined, sessionName?: string | null): string | undefined {
  const needsLookup = Boolean(workingTenantId) && !sessionName;
  const { data } = useQuery({
    queryKey: ['admin', 'tenants', 'switcher'],
    queryFn: async () => {
      const response = await fetch('/api/hope/admin/tenants?limit=100');
      if (!response.ok) throw new Error(`Failed to load tenants (${response.status})`);
      const body = (await response.json()) as { data?: TenantListItem[] };
      return body.data ?? [];
    },
    enabled: needsLookup,
    staleTime: 60_000,
  });
  if (sessionName) return sessionName;
  return data?.find((tenant) => tenant.id === workingTenantId)?.name;
}
