'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconArchive, IconBuildings, IconDots, IconEye, IconFilterOff, IconPlayerPause, IconPlus, IconRestore, IconTrash } from '@tabler/icons-react';
import { type ColumnDef, type SortRule } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useTenants } from '../api/hooks';
import type { Tenant } from '../api/types';
import { CreateTenantDialog } from './create-tenant-dialog';
import { PLAN_FILTER_OPTIONS, TenantPlanBadge } from './plan-badge';
import { TenantLifecycleDialogs, type LifecycleAction, type LifecycleRequest } from './tenant-lifecycle-dialogs';

/** Omni search targets (→ gateway `searchFields`) and the implicit sort — stable refs for the hook. */
const TENANT_SEARCH_FIELDS = ['name', 'key'];
const TENANT_DEFAULT_SORT: SortRule[] = [{ id: 'updatedAt', desc: true }];

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'ENABLED', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'DISABLED', label: 'Disabled' },
  { value: 'ARCHIVED', label: 'Archived' },
];

function RowActions({ tenant, onView, onAction }: { tenant: Tenant; onView: () => void; onAction: (action: LifecycleAction) => void }) {
  const status = tenant.resourceStatus;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${tenant.name}`} onClick={(event) => event.stopPropagation()}>
          <IconDots aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/* The portal content still bubbles through the React tree to the row's onClick. */}
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={onView}>
          <IconEye aria-hidden />
          View
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {status === 'ENABLED' ? (
          <DropdownMenuItem onSelect={() => onAction('suspend')}>
            <IconPlayerPause aria-hidden />
            Suspend
          </DropdownMenuItem>
        ) : null}
        {status === 'SUSPENDED' || status === 'ARCHIVED' ? (
          <DropdownMenuItem onSelect={() => onAction('restore')}>
            <IconRestore aria-hidden />
            Restore
          </DropdownMenuItem>
        ) : null}
        {status !== 'ARCHIVED' ? (
          <DropdownMenuItem onSelect={() => onAction('archive')}>
            <IconArchive aria-hidden />
            Archive
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onAction('delete')}>
          <IconTrash aria-hidden />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Frame 12 — Tenants list: AdminDataGrid (omni search + typed filters + sort + pager) + wizard. */
export function TenantsListScreen() {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleRequest | null>(null);

  const query = useAdminGridParams({ searchFields: TENANT_SEARCH_FIELDS, defaultSort: TENANT_DEFAULT_SORT });
  const { data, isLoading, isFetching, error, refetch } = useTenants(query.listParams);
  const { rows, total } = normalizeList<Tenant>(data);
  const totalCount = total ?? 0;

  const clearFilters = useCallback(() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }), [query]);

  const columns = useMemo<ColumnDef<Tenant>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        meta: { label: 'Name' },
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
        size: 260,
        minSize: 160,
      },
      {
        accessorKey: 'key',
        header: 'Key',
        enableSorting: false,
        meta: { label: 'Key' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.key}</span>,
        size: 180,
      },
      {
        accessorKey: 'plan',
        header: 'Plan',
        enableSorting: false,
        meta: { label: 'Plan', variant: 'multiSelect', options: PLAN_FILTER_OPTIONS },
        cell: ({ row }) => <TenantPlanBadge plan={row.original.plan} />,
        size: 120,
      },
      {
        accessorKey: 'resourceStatus',
        header: 'Status',
        enableSorting: false,
        meta: { label: 'Status', variant: 'multiSelect', options: STATUS_OPTIONS },
        cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus} />,
        size: 140,
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        meta: { label: 'Updated' },
        cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.updatedAt)}</span>,
        size: 160,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { label: 'Actions' },
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        size: 56,
        minSize: 56,
        cell: ({ row }) => (
          <div className="flex w-full justify-end">
            <RowActions
              tenant={row.original}
              onView={() => router.push(`/tenants/${row.original.id}`)}
              onAction={(action) => setLifecycle({ action, tenant: row.original })}
            />
          </div>
        ),
      },
    ],
    [router],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Tenants"
            meta={data ? <span>{formatNumber(totalCount)} tenants</span> : <Skeleton className="h-4 w-20" />}
            actions={
              <Button onClick={() => setCreateOpen(true)}>
                <IconPlus aria-hidden />
                New tenant
              </Button>
            }
          />
        }
        footer={
          <StatusFooter
            start={<span>{isFetching && !isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/tenants
              </span>
            }
          />
        }
      >
        <AdminDataGrid<Tenant>
          gridId="tenants"
          aria-label="Tenants"
          columns={columns}
          rows={rows}
          total={totalCount}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          isLoading={isLoading}
          isBusy={isFetching && !isLoading}
          error={error}
          onRetry={() => refetch()}
          onRowClick={(row) => router.push(`/tenants/${row.id}`)}
          emptyState={
            <EmptyState
              icon={IconBuildings}
              title="No tenants yet"
              description="Create the first tenant to onboard an organization."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <IconPlus aria-hidden />
                  New tenant
                </Button>
              }
            />
          }
          emptyFilteredState={
            <EmptyState
              icon={IconFilterOff}
              title="No tenants match your filters"
              description="Try a different search or clear the filters."
              action={
                <Button variant="outline" onClick={clearFilters}>
                  <IconFilterOff aria-hidden />
                  Clear filters
                </Button>
              }
            />
          }
        />
      </ScreenTemplate>
      <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} />
      <TenantLifecycleDialogs request={lifecycle} onOpenChange={(open) => !open && setLifecycle(null)} />
    </>
  );
}
