'use client';

import { useState } from 'react';
import { IconBuildings, IconX } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import type { SafeSession } from '@/shared/auth/hooks';

interface TenantListItem {
  id: string;
  name: string;
}

/**
 * Working-tenant selector for the elevated cross-tenant set. The list is
 * lazy-loaded through the BFF proxy on first open; the selection is stored in
 * the session cookie so the proxy scopes subsequent requests via X-Tenant-Id.
 */
export function TenantSwitcher({ session }: { session: SafeSession }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: tenants, isPending } = useQuery({
    queryKey: ['admin', 'tenants', 'switcher'],
    queryFn: async () => {
      const response = await fetch('/api/hope/admin/tenants?limit=100');
      if (!response.ok) {
        throw new Error(`Failed to load tenants (${response.status})`);
      }
      const body = (await response.json()) as { data?: TenantListItem[] };
      return body.data ?? [];
    },
    enabled: open,
    staleTime: 60_000,
  });

  const activeTenantName = session.workingTenantName ?? tenants?.find((tenant) => tenant.id === session.workingTenantId)?.name;

  async function applySelection(tenant: TenantListItem | null) {
    setSaving(true);
    try {
      await fetch('/api/auth/working-tenant', {
        method: tenant ? 'POST' : 'DELETE',
        ...(tenant
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ tenantId: tenant.id, tenantName: tenant.name }),
            }
          : {}),
      });
      // Scope changed: server components re-read the session, queries refetch.
      await queryClient.invalidateQueries();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {session.workingTenantId ? (
        <Badge variant="secondary" className="max-w-48 truncate">
          Acting on: {activeTenantName ?? session.workingTenantId}
        </Badge>
      ) : null}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={saving}>
            <IconBuildings className="size-4" />
            Working tenant
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64">
          <DropdownMenuLabel>Select a working tenant</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {isPending ? (
            <div className="flex flex-col gap-2 p-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : (
            <>
              {(tenants ?? []).map((tenant) => (
                <DropdownMenuItem key={tenant.id} onSelect={() => void applySelection(tenant)}>
                  <span className="truncate">{tenant.name}</span>
                </DropdownMenuItem>
              ))}
              {tenants && tenants.length === 0 ? <DropdownMenuItem disabled>No tenants available</DropdownMenuItem> : null}
            </>
          )}
          {session.workingTenantId ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void applySelection(null)}>
                <IconX />
                Clear selection
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
