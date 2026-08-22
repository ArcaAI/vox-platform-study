'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  IconDots,
  IconDownload,
  IconEye,
  IconFilterOff,
  IconKey,
  IconPlus,
  IconTrash,
  IconUserCheck,
  IconUserOff,
  IconUsers,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef, type RowSelectionState, type SortRule } from '@arcaai/ui';
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
import { GatewayError } from '@/shared/api';
import { useTenantCatalog, useTenantNames } from '@/shared/catalog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { toListParams } from '@/shared/data/grid-url-state';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useBulkDeleteUsers, useBulkUserAction, useExportUsers, useUsers, useUsersByTenant } from '../api/hooks';
import type { User, UserRoleAssignment } from '../api/types';
import { CreateUserDialog } from './create-user-dialog';
import { UserActionDialogs, type UserActionRequest } from './user-action-dialogs';
import { UserAvatar } from './user-avatar';

/** Omni search targets (→ gateway `searchFields`) and the implicit sort — stable refs for the hook. */
const USER_SEARCH_FIELDS = ['username', 'externalId'];
const USER_DEFAULT_SORT: SortRule[] = [{ id: 'createdAt', desc: true }];
const ROLE_CHIP_LIMIT = 2;
const TENANT_CHIP_LIMIT = 2;

/**
 * The User model has no `tenantId` column (tenancy = role
 * assignments), so the in-page Tenant filter cannot ride the CSV filter
 * grammar. The screen strips this rule from the list params and swaps to the
 * membership-based by-tenant route instead.
 */
const TENANT_FILTER_ID = 'tenantId';

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'ENABLED', label: 'Active' },
  { value: 'DISABLED', label: 'Disabled' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'ARCHIVED', label: 'Archived' },
];

/** isServiceAccount is a real boolean column — the only "type" the list knows. */
const TYPE_OPTIONS: FilterOption[] = [
  { value: 'false', label: 'Users' },
  { value: 'true', label: 'Service accounts' },
];

type BulkAction = 'enable' | 'disable' | 'delete';

/** Extract the download filename the gateway suggests via Content-Disposition. */
function filenameFromDisposition(disposition: string | null): string | undefined {
  const match = disposition?.match(/filename="?([^";]+)"?/i);
  return match?.[1];
}

/** Role chips truncate at +N per frame 20; absent on payloads without roles. */
function RolesCell({ assignments }: { assignments?: UserRoleAssignment[] }) {
  if (!assignments?.length) return <span className="text-muted-foreground">{'\u2014'}</span>;
  const shown = assignments.slice(0, ROLE_CHIP_LIMIT);
  const extra = assignments.length - shown.length;
  return (
    <span className="flex items-center gap-1">
      {shown.map((assignment) => (
        <Badge key={assignment.id} variant="secondary">
          {assignment.roleName ?? assignment.roleId}
        </Badge>
      ))}
      {extra > 0 ? <Badge variant="outline">+{extra}</Badge> : null}
    </span>
  );
}

/** Distinct tenants from the user's role assignments; names degrade to raw ids while the catalog loads. */
function TenantsCell({ assignments, tenantNames }: { assignments?: UserRoleAssignment[]; tenantNames: Map<string, string> }) {
  const tenantIds = Array.from(new Set((assignments ?? []).map((assignment) => assignment.tenantId).filter((id): id is string => !!id)));
  if (tenantIds.length === 0) return <span className="text-muted-foreground">{'\u2014'}</span>;
  const shown = tenantIds.slice(0, TENANT_CHIP_LIMIT);
  const extra = tenantIds.length - shown.length;
  return (
    <span className="flex items-center gap-1">
      {shown.map((id) => (
        <Badge key={id} variant="outline">
          {tenantNames.get(id) ?? id}
        </Badge>
      ))}
      {extra > 0 ? <Badge variant="outline">+{extra}</Badge> : null}
    </span>
  );
}

function RowActions({ user, onView, onAction }: { user: User; onView: () => void; onAction: (action: UserActionRequest['action']) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${user.username}`} onClick={(event) => event.stopPropagation()}>
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
        {user.resourceStatus === 'ENABLED' ? (
          <DropdownMenuItem onSelect={() => onAction('disable')}>
            <IconUserOff aria-hidden />
            Disable
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onAction('enable')}>
            <IconUserCheck aria-hidden />
            Enable
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onAction('reset-password')}>
          <IconKey aria-hidden />
          Reset password
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onAction('delete')}>
          <IconTrash aria-hidden />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const BULK_COPY: Record<
  BulkAction,
  { title: (count: number) => string; description: string; confirmLabel: string; destructive: boolean; success: string }
> = {
  enable: {
    title: (count) => `Enable ${count} user${count === 1 ? '' : 's'}?`,
    description: 'The selected users can sign in and use the platform again.',
    confirmLabel: 'Enable',
    destructive: false,
    success: 'enabled',
  },
  disable: {
    title: (count) => `Disable ${count} user${count === 1 ? '' : 's'}?`,
    description: 'The selected users can no longer sign in. Their data and assignments are kept.',
    confirmLabel: 'Disable',
    destructive: true,
    success: 'disabled',
  },
  delete: {
    title: (count) => `Delete ${count} user${count === 1 ? '' : 's'}?`,
    description: 'This soft-deletes every selected user and removes them from all lists.',
    confirmLabel: 'Delete users',
    destructive: true,
    success: 'deleted',
  },
};

/** Frame 20 — Users list: AdminDataGrid with grid selection + bulk action bar (enable/disable/delete + export). */
export function UsersListScreen() {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [action, setAction] = useState<UserActionRequest | null>(null);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const bulkAction = useBulkUserAction();
  const bulkDelete = useBulkDeleteUsers();
  const exportUsersMutation = useExportUsers();

  const query = useAdminGridParams({ searchFields: USER_SEARCH_FIELDS, defaultSort: USER_DEFAULT_SORT });
  const tenantNames = useTenantNames();
  const tenantCatalog = useTenantCatalog();
  const tenantOptions = useMemo<FilterOption[]>(
    () => (tenantCatalog.data ?? []).map((tenant) => ({ value: tenant.id, label: tenant.name || tenant.key || tenant.id })),
    [tenantCatalog.data],
  );

  // The Tenant filter cannot ride the CSV grammar (no tenantId
  // column on User): strip it from the params and route the fetch through the
  // membership-based `GET /admin/users/tenant/:id` instead.
  const tenantFilter = query.queryState.filters.find(
    (rule) => rule.id === TENANT_FILTER_ID && typeof rule.value === 'string' && rule.value.length > 0,
  );
  const filterTenantId = tenantFilter ? String(tenantFilter.value) : '';
  const listParams = useMemo(
    () =>
      filterTenantId
        ? toListParams(
            { ...query.queryState, filters: query.queryState.filters.filter((rule) => rule.id !== TENANT_FILTER_ID) },
            { searchFields: USER_SEARCH_FIELDS },
          )
        : query.listParams,
    [filterTenantId, query.queryState, query.listParams],
  );

  const allUsersQuery = useUsers(listParams, { enabled: !filterTenantId });
  const byTenantQuery = useUsersByTenant(filterTenantId, listParams);
  const { data, isLoading, isFetching, error, refetch } = filterTenantId ? byTenantQuery : allUsersQuery;
  const { rows, total } = normalizeList<User>(data);
  const totalCount = total ?? 0;

  const selectedIds = useMemo(() => Object.keys(selection).filter((id) => selection[id]), [selection]);

  const clearFilters = useCallback(() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }), [query]);

  function finishBulk(succeeded: number, failed: number) {
    const copy = BULK_COPY[bulk as BulkAction];
    if (failed > 0) {
      toast.error(`${succeeded} of ${succeeded + failed} users ${copy.success} \u2014 ${failed} failed`);
    } else {
      toast.success(`${succeeded} user${succeeded === 1 ? '' : 's'} ${copy.success}`);
    }
    setSelection({});
    setBulk(null);
  }

  function handleBulkConfirm() {
    if (!bulk) return;
    if (bulk === 'delete') {
      bulkDelete.mutate(selectedIds, {
        onSuccess: (result) => finishBulk(result.succeeded.length, result.failed.length),
        onError: (mutationError) => toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Bulk delete failed.'),
      });
      return;
    }
    bulkAction.mutate(
      { action: bulk, ids: selectedIds },
      {
        onSuccess: (result) => finishBulk(result.succeeded, result.failed),
        onError: (mutationError) => toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Bulk action failed.'),
      },
    );
  }

  /** Export the current filtered view (not just the selection) — the gateway export takes ListParams. */
  function handleExport() {
    exportUsersMutation.mutate(
      // The tenant filter travels as a dedicated query param (see listParams note above).
      { ...listParams, format: 'csv', ...(filterTenantId ? { tenantId: filterTenantId } : {}) },
      {
        onSuccess: ({ blob, contentDisposition }) => {
          const filename = filenameFromDisposition(contentDisposition) ?? 'users.csv';
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filename;
          anchor.click();
          URL.revokeObjectURL(url);
          toast.success(`Export ready \u2014 ${filename}`);
        },
        onError: (mutationError) => toast.error(mutationError instanceof Error ? mutationError.message : 'Export failed'),
      },
    );
  }

  const columns = useMemo<ColumnDef<User>[]>(
    () => [
      {
        accessorKey: 'username',
        header: 'User',
        meta: { label: 'User' },
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <UserAvatar username={row.original.username} size="sm" />
            <span className="font-medium">{row.original.username}</span>
          </span>
        ),
        size: 240,
        minSize: 160,
      },
      {
        id: 'roles',
        header: 'Roles',
        enableSorting: false,
        meta: { label: 'Roles' },
        cell: ({ row }) => <RolesCell assignments={row.original.UserRoleAssignments} />,
        size: 200,
      },
      {
        // Cross-tenant view: which tenant(s) the user belongs
        // to (via role assignments) + a tenant filter (see listParams).
        // The accessorFn makes this an ACCESSOR column so TanStack's
        // getCanFilter() is true and the faceted filter renders; actual
        // filtering is server-side (manual filtering).
        id: TENANT_FILTER_ID,
        accessorFn: (row: User) => row.UserRoleAssignments?.[0]?.tenantId ?? '',
        header: 'Tenant',
        enableSorting: false,
        meta: { label: 'Tenant', variant: 'select', options: tenantOptions },
        cell: ({ row }) => <TenantsCell assignments={row.original.UserRoleAssignments} tenantNames={tenantNames} />,
        size: 180,
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
        accessorKey: 'isServiceAccount',
        header: 'Type',
        enableSorting: false,
        meta: { label: 'Type', variant: 'select', options: TYPE_OPTIONS },
        cell: ({ row }) =>
          row.original.isServiceAccount ? <Badge variant="outline">Service account</Badge> : <span className="text-muted-foreground">User</span>,
        size: 150,
      },
      {
        accessorKey: 'lastLoginAt',
        header: 'Last login',
        meta: { label: 'Last login' },
        cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.lastLoginAt)}</span>,
        size: 150,
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        meta: { label: 'Created' },
        cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.createdAt)}</span>,
        size: 140,
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
              user={row.original}
              onView={() => router.push(`/users/${row.original.id}`)}
              onAction={(rowAction) => setAction({ action: rowAction, user: row.original })}
            />
          </div>
        ),
      },
    ],
    [router, tenantNames, tenantOptions],
  );

  const actionBar = (
    <div role="toolbar" aria-label="Bulk actions" className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-2">
      <span className="px-1 text-sm font-medium" aria-live="polite">
        {selectedIds.length} selected
      </span>
      <Button variant="outline" size="sm" onClick={() => setBulk('enable')}>
        <IconUserCheck aria-hidden />
        Enable
      </Button>
      <Button variant="outline" size="sm" onClick={() => setBulk('disable')}>
        <IconUserOff aria-hidden />
        Disable
      </Button>
      <Button variant="destructive" size="sm" onClick={() => setBulk('delete')}>
        <IconTrash aria-hidden />
        Delete
      </Button>
      <Button variant="outline" size="sm" onClick={handleExport} disabled={exportUsersMutation.isPending}>
        <IconDownload aria-hidden />
        Export
      </Button>
      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelection({})}>
        Clear selection
      </Button>
    </div>
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Users"
            meta={data ? <span>{formatNumber(totalCount)} users</span> : <Skeleton className="h-4 w-16" />}
            actions={
              <Button onClick={() => setCreateOpen(true)}>
                <IconPlus aria-hidden />
                New user
              </Button>
            }
          />
        }
        footer={
          <StatusFooter
            start={<span>{isFetching && !isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/users
              </span>
            }
          />
        }
      >
        <AdminDataGrid<User>
          gridId="users"
          aria-label="Users"
          columns={columns}
          rows={rows}
          total={totalCount}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          isLoading={isLoading}
          isBusy={isFetching && !isLoading}
          error={error}
          onRetry={() => refetch()}
          onRowClick={(row) => router.push(`/users/${row.id}`)}
          selection={{ value: selection, onChange: setSelection }}
          actionBar={actionBar}
          emptyState={
            <EmptyState
              icon={IconUsers}
              title="No users yet"
              description="Create the first user to grant console or SDK access."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <IconPlus aria-hidden />
                  New user
                </Button>
              }
            />
          }
          emptyFilteredState={
            <EmptyState
              icon={IconFilterOff}
              title="No users match your filters"
              description="Try a different search or clear the filters."
              action={
                <Button variant="outline" onClick={clearFilters} aria-label="Clear filters and show all rows">
                  <IconFilterOff aria-hidden />
                  Clear filters
                </Button>
              }
            />
          }
        />
      </ScreenTemplate>
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <UserActionDialogs request={action} onOpenChange={(open) => !open && setAction(null)} />
      {bulk ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setBulk(null)}
          title={BULK_COPY[bulk].title(selectedIds.length)}
          description={BULK_COPY[bulk].description}
          confirmLabel={BULK_COPY[bulk].confirmLabel}
          destructive={BULK_COPY[bulk].destructive}
          isPending={bulkAction.isPending || bulkDelete.isPending}
          onConfirm={handleBulkConfirm}
        />
      ) : null}
    </>
  );
}
