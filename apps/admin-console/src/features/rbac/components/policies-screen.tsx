'use client';

import { useState } from 'react';
import { IconDots, IconLock, IconPencil, IconPlus, IconShieldSearch, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { BreakGlassDialog, type BreakGlassCredentials } from '@/shared/confirm/break-glass-dialog';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useDeletePolicy, usePolicies } from '../api/hooks';
import type { Policy, PolicyScope } from '../api/types';
import { PolicyFormSheet } from './policy-form-sheet';

/** RBAC gateway page size default (the surface pages one-based with `pageSize`). */
const DEFAULT_LIMIT = 25;

const SCOPE_OPTIONS: FilterOption[] = [
  { value: 'GLOBAL', label: 'Global' },
  { value: 'TENANT', label: 'Tenant' },
];

const SCOPE_LABELS: Record<PolicyScope, string> = { GLOBAL: 'Global', TENANT: 'Tenant' };

function RowActions({ policy, onEdit, onDelete }: { policy: Policy; onEdit: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${policy.name}`} onClick={(event) => event.stopPropagation()}>
          <IconDots aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/* The portal content still bubbles through the React tree to the row's onClick. */}
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={onEdit}>
          <IconPencil aria-hidden />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Protected system policies are the anti-lockout set — the gateway always refuses (403). */}
        <DropdownMenuItem variant="destructive" disabled={policy.isProtected} onSelect={onDelete}>
          <IconTrash aria-hidden />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Frame 22 — RBAC Policies (/rbac/policies, shared tier 20-29). AdminDataGrid
 * over the RBAC surface's one-based `{ data, total, page, pageSize }` envelope.
 * The scope facet is a typed `select` column filter; its value is lifted back
 * out of the grid's filter state and sent as the gateway's raw `scope` param
 * (the RBAC surface predates the bracket-grammar filter contract). The surface
 * has no server sort, so every column opts out of sorting. Row click / edit ->
 * the create/edit sheet hosting the JSON rules editor; break-glass delete
 * (DELETE body carries password + confirmationName = the POLICY's exact name).
 */
export function PoliciesScreen() {
  const query = useAdminGridParams();
  // The scope facet rides in the grid filter state; RBAC wants it as a raw `scope` param.
  const scopeFilter = query.queryState.filters.find((filter) => filter.id === 'scope');
  const scope = typeof scopeFilter?.value === 'string' ? (scopeFilter.value as PolicyScope) : undefined;

  // The RBAC gateway uses `pageSize` (not `limit`); `listParams.page` is already
  // 1-based from the grid seam (`toListParams`), so pass it through unchanged.
  const { data, isLoading, isFetching, error, refetch } = usePolicies({
    page: query.listParams.page ?? 1,
    pageSize: query.listParams.limit ?? DEFAULT_LIMIT,
    ...(query.listParams.search ? { search: query.listParams.search } : {}),
    ...(scope ? { scope } : {}),
  });
  const { rows, total } = normalizeList<Policy>(data, { pageBase: 1 });
  const totalCount = total ?? 0;

  const [sheet, setSheet] = useState<{ open: boolean; policyId: string | null }>({ open: false, policyId: null });
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletePolicy = useDeletePolicy();

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setDeleteError(null);
    deletePolicy.reset();
  }

  function handleDeleteConfirm(credentials: BreakGlassCredentials) {
    if (!deleteTarget) return;
    deletePolicy.mutate(
      { id: deleteTarget.id, breakGlass: credentials },
      {
        onSuccess: () => {
          toast.success('Policy deleted');
          closeDeleteDialog();
        },
        // 401 wrong password / 400 name mismatch / 403 protected —
        // surfaced inside the dialog, not as a toast.
        onError: (error) => setDeleteError(error.message),
      },
    );
  }

  const columns: ColumnDef<Policy>[] = [
    {
      accessorKey: 'name',
      header: 'Policy',
      enableSorting: false,
      meta: { label: 'Policy' },
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{row.original.name}</span>
          {row.original.isProtected ? (
            <Badge variant="secondary">
              <IconLock aria-hidden />
              Protected
            </Badge>
          ) : null}
        </span>
      ),
      size: 280,
      minSize: 180,
    },
    {
      accessorKey: 'scope',
      header: 'Scope',
      enableSorting: false,
      meta: { label: 'Scope', variant: 'select', options: SCOPE_OPTIONS },
      cell: ({ row }) => <Badge variant="outline">{SCOPE_LABELS[row.original.scope] ?? row.original.scope}</Badge>,
      size: 140,
    },
    {
      id: 'rules',
      header: 'Rules',
      enableSorting: false,
      meta: { label: 'Rules' },
      cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.rules.length)}</span>,
      size: 100,
    },
    {
      accessorKey: 'resourceStatus',
      header: 'Status',
      enableSorting: false,
      meta: { label: 'Status' },
      cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus} />,
      size: 140,
    },
    {
      accessorKey: 'updatedAt',
      header: 'Updated',
      enableSorting: false,
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
            policy={row.original}
            onEdit={() => setSheet({ open: true, policyId: row.original.id })}
            onDelete={() => setDeleteTarget(row.original)}
          />
        </div>
      ),
    },
  ];

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Policies"
            meta={
              <>
                {data ? <span>{formatNumber(totalCount)} policies</span> : <Skeleton className="h-4 w-24" />}
                <span>resource.action grammar</span>
              </>
            }
            actions={
              <Button onClick={() => setSheet({ open: true, policyId: null })}>
                <IconPlus aria-hidden />
                New policy
              </Button>
            }
          />
        }
        footer={
          <StatusFooter
            start={<span>{isFetching && !isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/rbac/policies
              </span>
            }
          />
        }
      >
        <AdminDataGrid<Policy>
          gridId="rbac-policies"
          aria-label="Policies"
          columns={columns}
          rows={rows}
          total={totalCount}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          isLoading={isLoading}
          isBusy={isFetching && !isLoading}
          error={error}
          onRetry={() => refetch()}
          onRowClick={(row) => setSheet({ open: true, policyId: row.id })}
          emptyState={
            <EmptyState
              icon={IconShieldSearch}
              title="No policies match"
              description="Seeded platform defaults always exist — adjust the filters or create a new policy."
              action={
                <Button onClick={() => setSheet({ open: true, policyId: null })}>
                  <IconPlus aria-hidden />
                  New policy
                </Button>
              }
            />
          }
          emptyFilteredState={
            <EmptyState
              icon={IconShieldSearch}
              title="No policies match"
              description="Seeded platform defaults always exist — adjust the filters or create a new policy."
              action={
                <Button variant="outline" onClick={() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] })}>
                  Clear filters
                </Button>
              }
            />
          }
        />
      </ScreenTemplate>
      <PolicyFormSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((current) => ({ open, policyId: open ? current.policyId : null }))}
        policyId={sheet.policyId}
      />
      <BreakGlassDialog
        key={deleteTarget?.id ?? 'delete-policy'}
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && closeDeleteDialog()}
        title="Delete policy"
        description={
          <>
            Soft-deletes <span className="font-mono">{deleteTarget?.name}</span>. Roles holding it lose the permissions it grants. Confirm with your
            password and the exact policy name.
          </>
        }
        confirmationName={deleteTarget?.name ?? ''}
        confirmLabel="Delete policy"
        onConfirm={handleDeleteConfirm}
        isPending={deletePolicy.isPending}
        error={deleteError}
      />
    </>
  );
}
