'use client';

import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconFilterOff, IconPencil, IconPlus, IconShieldCheck, IconTrash, IconWorld } from '@tabler/icons-react';
import { toast } from 'sonner';
import { VirtualizedDataGrid, includesSomeFilter, type ColumnDef } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorBanner } from '@/shared/state/error-state';
import { EmptyState } from '@/shared/state/empty-state';
import { RESOURCE_STATUS_META, ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useAllowedOriginPosture, useDeleteAllowedOrigin, useAllowedOrigins } from '../api';
import type { TenantAllowedOrigin } from '../api';
import { AllowedOriginFormDialog } from './allowed-origin-form-dialog';

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'ENABLED', label: RESOURCE_STATUS_META.ENABLED.label },
  { value: 'DISABLED', label: RESOURCE_STATUS_META.DISABLED.label },
];

/**
 * Enforcement disclosure (FR-4). `origin.enforcementEnabled` is a single
 * platform-wide boolean (`GET /admin/allowed-origins/posture`), never
 * per-tenant — reachable by TENANT_ADMIN and SUPER_ADMIN alike. When it is
 * OFF the rows below have NO effect (every browser origin is admitted
 * regardless of what is registered), so that state gets a prominent warning;
 * ON only needs a quiet confirmation.
 */
function EnforcementBanner() {
  const query = useAllowedOriginPosture();

  if (query.isPending) {
    return <Skeleton className="h-10 w-full rounded-md" aria-hidden />;
  }

  if (query.error) {
    return <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />;
  }

  if (!query.data?.enforcementEnabled) {
    return (
      <div role="alert" className="border-warning/40 bg-warning/10 text-foreground flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
        <IconAlertTriangle aria-hidden className="text-warning-strong mt-0.5 size-4 shrink-0" />
        <p>
          <span className="font-medium">Origin enforcement is off, platform-wide</span> — no browser origin is being checked right now, so the
          rows below have no effect until a platform administrator turns enforcement back on.
        </p>
      </div>
    );
  }

  return (
    <div role="status" className="bg-info/10 text-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm">
      <IconShieldCheck aria-hidden className="text-info size-4 shrink-0" />
      <span>Origin enforcement is on — only the origins registered below are allowed to reach the API.</span>
    </div>
  );
}

/** Allowed origins (/allowed-origins, tier 30-49 — TENANT_ADMIN for their own tenant's rows, SUPER_ADMIN unchanged). */
export function AllowedOriginsScreen() {
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
        statusBanner={<EnforcementBanner />}
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
                description="There is no fallback allow-list — every browser origin is refused until you register one."
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
