'use client';

import { useMemo, useState } from 'react';
import { IconFilterOff, IconPencil, IconPlus, IconShieldLock, IconTrash, IconWorld } from '@tabler/icons-react';
import { toast } from 'sonner';
import { VirtualizedDataGrid, includesSomeFilter, type ColumnDef } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useSession } from '@/shared/auth';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { RESOURCE_STATUS_META, ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDeleteAllowedOrigin, useAllowedOrigins } from '../api';
import type { TenantAllowedOrigin } from '../api';
import { AllowedOriginFormDialog } from './allowed-origin-form-dialog';

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'ENABLED', label: RESOURCE_STATUS_META.ENABLED.label },
  { value: 'DISABLED', label: RESOURCE_STATUS_META.DISABLED.label },
];

function LoadingTable() {
  return (
    <div className="rounded-md border" aria-hidden>
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-48" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

/** Allowed origins (/allowed-origins, tier 10-19, GLOBAL_ADMIN). */
export function AllowedOriginsScreen() {
  const session = useSession();
  const isElevated = session.data?.isElevated ?? false;

  if (session.isPending) {
    return (
      <ScreenTemplate header={<PageHeader title="Allowed origins" />}>
        <LoadingTable />
      </ScreenTemplate>
    );
  }

  if (!isElevated) {
    return (
      <ScreenTemplate header={<PageHeader title="Allowed origins" />}>
        <EmptyState icon={IconShieldLock} title="Global admins only" description="The CORS allow-list is managed by global administrators." />
      </ScreenTemplate>
    );
  }

  return (
    <WorkingTenantGate
      title="Allowed origins"
      meta={<span>CORS allow-list · effective without restart</span>}
      description="CORS allow-list rows are tenant-scoped. Pick a working tenant from the top-bar switcher to load its origins."
    >
      <AllowedOriginsBody />
    </WorkingTenantGate>
  );
}

function AllowedOriginsBody() {
  const query = useAllowedOrigins(true);
  const deleteMutation = useDeleteAllowedOrigin();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TenantAllowedOrigin | null>(null);

  const rows = useMemo(() => query.data ?? [], [query.data]);
  const total = rows.length;

  function openCreate() {
    setEditingId(null);
    setSheetOpen(true);
  }

  function openEdit(row: TenantAllowedOrigin) {
    setEditingId(row.id);
    setSheetOpen(true);
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success('Origin removed');
        setDeleteTarget(null);
      },
      onError: (error) => toast.error(error.message),
    });
  }

  const columns = useMemo<ColumnDef<TenantAllowedOrigin>[]>(
    () => [
      {
        accessorKey: 'origin',
        header: 'Origin',
        meta: { label: 'Origin' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.origin}</span>,
        size: 260,
        minSize: 180,
      },
      {
        accessorKey: 'label',
        header: 'Label',
        meta: { label: 'Label' },
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{row.original.label}</span>
            {row.original.description ? <span className="text-muted-foreground line-clamp-1 text-xs">{row.original.description}</span> : null}
          </div>
        ),
        size: 240,
        minSize: 160,
      },
      {
        id: 'status',
        accessorFn: (row) => row.resourceStatus ?? '',
        header: 'Status',
        enableSorting: false,
        enableGlobalFilter: false,
        filterFn: includesSomeFilter,
        meta: { label: 'Status', variant: 'multiSelect', options: STATUS_OPTIONS },
        cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus ?? null} />,
        size: 140,
      },
      {
        id: 'updated',
        header: 'Updated',
        enableGlobalFilter: false,
        accessorFn: (row) => row.updatedAt,
        meta: { label: 'Updated' },
        cell: ({ row }) => <span className="text-muted-foreground text-xs">{formatRelativeTime(row.original.updatedAt)}</span>,
        size: 140,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { label: 'Actions' },
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        enableGlobalFilter: false,
        size: 96,
        minSize: 96,
        cell: ({ row }) => (
          <span className="flex w-full items-center justify-end gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${row.original.label}`} onClick={() => openEdit(row.original)}>
              <IconPencil aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${row.original.label}`} onClick={() => setDeleteTarget(row.original)}>
              <IconTrash aria-hidden />
            </Button>
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Allowed origins"
            meta={<span>CORS allow-list · effective without restart</span>}
            actions={
              <Button onClick={openCreate}>
                <IconPlus aria-hidden data-icon="inline-start" />
                Register origin
              </Button>
            }
          />
        }
        footer={
          <StatusFooter
            start={<span>{query.isFetching && !query.isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/allowed-origins · {total} origin{total === 1 ? '' : 's'}
              </span>
            }
          />
        }
      >
        <VirtualizedDataGrid<TenantAllowedOrigin>
          aria-label="Allowed origins"
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          features={{
            globalSearch: true,
            facetedFilters: true,
            sorting: true,
            rowSelection: false,
            columnReorder: true,
            columnResize: true,
            columnPinning: true,
            columnVisibility: true,
          }}
          persistence={gridPersistence('allowed-origins')}
          isLoading={query.isLoading}
          isBusy={query.isFetching && !query.isLoading}
          error={query.error ?? undefined}
          onRetry={() => void query.refetch()}
          emptyState={
            total === 0 ? (
              <EmptyState
                icon={IconWorld}
                title="No origins registered"
                description="Browser apps fall back to CORS_ALLOWED_ORIGINS until an origin is registered."
                action={
                  <Button onClick={openCreate}>
                    <IconPlus aria-hidden data-icon="inline-start" />
                    Register origin
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={IconFilterOff} title="No origins match the filters" description="Adjust the search or filters." />
            )
          }
        />
      </ScreenTemplate>

      <AllowedOriginFormDialog
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) setEditingId(null);
        }}
        editingId={editingId}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Remove allowed origin?"
        description={
          deleteTarget ? (
            <>
              Removes <span className="font-medium">{deleteTarget.label}</span> (<span className="font-mono">{deleteTarget.origin}</span>) from the
              CORS allow-list. Browsers on this origin will be refused on the next request.
            </>
          ) : null
        }
        confirmLabel="Remove origin"
        destructive
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
