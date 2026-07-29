'use client';

import { useMemo, useState } from 'react';
import { IconChartBar, IconDots, IconFilterOff, IconKey, IconPencil, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef, type SortRule } from '@arcaai/ui';
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
import { useTenantCatalog, useTenantNames } from '@/shared/catalog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { NameWithId } from '@/shared/data/name-with-id';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { useApiKeyScopes, useApiKeys, useDeleteApiKey, useRevokeApiKey, useRotateApiKey } from '../api/hooks';
import type { ApiKey } from '../api/types';
import { ApiKeyFormDialog } from './api-key-form-dialog';
import { ApiKeyUsageSheet } from './api-key-usage-sheet';
import { KeyStatusBadge } from './key-status-badge';
import { RawKeyDialog, type RawKeyResult } from './raw-key-dialog';

/** Omni search targets (→ gateway `searchFields`) and the implicit sort — stable refs for the hook. */
const API_KEY_SEARCH_FIELDS = ['keyName', 'keyPrefix'];
const API_KEY_DEFAULT_SORT: SortRule[] = [{ id: 'updatedAt', desc: true }];

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'REVOKED', label: 'Revoked' },
];

const MAX_SCOPE_BADGES = 3;

function ScopeBadges({ scopes }: { scopes: string[] | null | undefined }) {
  if (!scopes?.length) return <span className="text-muted-foreground">&mdash;</span>;
  return (
    <span className="flex items-center gap-1">
      {scopes.slice(0, MAX_SCOPE_BADGES).map((scope) => (
        <Badge key={scope} variant="outline" className="font-mono text-[10px]">
          {scope}
        </Badge>
      ))}
      {scopes.length > MAX_SCOPE_BADGES ? <span className="text-muted-foreground text-xs">+{scopes.length - MAX_SCOPE_BADGES}</span> : null}
    </span>
  );
}

type RowAction = 'usage' | 'edit' | 'rotate' | 'revoke' | 'delete';

function RowActions({ apiKey, onAction }: { apiKey: ApiKey; onAction: (action: RowAction) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${apiKey.keyName}`} onClick={(event) => event.stopPropagation()}>
          <IconDots aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onAction('usage')}>
          <IconChartBar aria-hidden />
          View usage
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction('edit')}>
          <IconPencil aria-hidden />
          Edit
        </DropdownMenuItem>
        {apiKey.keyStatus === 'ACTIVE' ? (
          <DropdownMenuItem onSelect={() => onAction('rotate')}>
            <IconRefresh aria-hidden />
            Rotate
          </DropdownMenuItem>
        ) : null}
        {apiKey.keyStatus === 'ACTIVE' || apiKey.keyStatus === 'INACTIVE' ? (
          <DropdownMenuItem variant="destructive" onSelect={() => onAction('revoke')}>
            <IconKey aria-hidden />
            Revoke
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

/**
 * Frame 23 — API keys (/api-keys, tier 20-29 shared). AdminDataGrid (omni
 * search + typed status/scope filters + sort + pager), create/edit dialogs,
 * usage drawer, rotate/revoke/delete confirm flows and the one-time raw-key
 * contract: the secret from create or rotate is displayed exactly once.
 */
export function ApiKeysScreen() {
  const query = useAdminGridParams({ searchFields: API_KEY_SEARCH_FIELDS, defaultSort: API_KEY_DEFAULT_SORT });
  const { data, isLoading, isFetching, error, refetch } = useApiKeys(query.listParams);
  const scopesQuery = useApiKeyScopes();
  const { rows, total } = normalizeList<ApiKey>(data);
  const totalCount = total ?? 0;

  const scopeOptions = useMemo<FilterOption[]>(
    () =>
      Object.values(scopesQuery.data ?? {})
        .flat()
        .map(({ scope: value }) => ({ value, label: value })),
    [scopesQuery.data],
  );

  // Cross-tenant view: ApiKey rows carry tenantId, so the tenant
  // filter rides the regular CSV grammar (`tenantId[equals]:…`).
  const tenantNames = useTenantNames();
  const tenantCatalog = useTenantCatalog();
  const tenantOptions = useMemo<FilterOption[]>(
    () => (tenantCatalog.data ?? []).map((tenant) => ({ value: tenant.id, label: tenant.name || tenant.key || tenant.id })),
    [tenantCatalog.data],
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKey | null>(null);
  const [usageTarget, setUsageTarget] = useState<ApiKey | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKey | null>(null);
  // One-time raw-key state: set on create/rotate success, cleared on close —
  // once cleared the secret is unrecoverable by design.
  const [rawKey, setRawKey] = useState<RawKeyResult | null>(null);

  const rotateMutation = useRotateApiKey();
  const revokeMutation = useRevokeApiKey();
  const deleteMutation = useDeleteApiKey();

  function handleRowAction(apiKey: ApiKey, action: RowAction) {
    if (action === 'usage') setUsageTarget(apiKey);
    if (action === 'edit') setEditTarget(apiKey);
    if (action === 'rotate') setRotateTarget(apiKey);
    if (action === 'revoke') setRevokeTarget(apiKey);
    if (action === 'delete') setDeleteTarget(apiKey);
  }

  function confirmRotate() {
    if (!rotateTarget) return;
    rotateMutation.mutate(rotateTarget.id, {
      onSuccess: (result) => {
        toast.success('API key rotated');
        setRotateTarget(null);
        setRawKey({ rawKey: result.rawKey, keyName: result.apiKey.keyName, mode: 'rotated' });
      },
      onError: (mutationError) => toast.error(mutationError.message),
    });
  }

  function confirmRevoke() {
    if (!revokeTarget) return;
    revokeMutation.mutate(revokeTarget.id, {
      onSuccess: () => {
        toast.success('API key revoked');
        setRevokeTarget(null);
      },
      onError: (mutationError) => toast.error(mutationError.message),
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success('API key deleted');
        setDeleteTarget(null);
      },
      onError: (mutationError) => toast.error(mutationError.message),
    });
  }

  const columns: ColumnDef<ApiKey>[] = [
    {
      accessorKey: 'keyName',
      header: 'Name',
      meta: { label: 'Name' },
      cell: ({ row }) => <span className="font-medium">{row.original.keyName}</span>,
      size: 200,
      minSize: 140,
    },
    {
      id: 'prefix',
      header: 'Prefix',
      enableSorting: false,
      meta: { label: 'Prefix' },
      cell: ({ row }) => <span className="font-mono text-xs">{`${row.original.keyPrefix}\u2026`}</span>,
      size: 120,
    },
    {
      accessorKey: 'tenantId',
      header: 'Tenant',
      enableSorting: false,
      meta: { label: 'Tenant', variant: 'multiSelect', options: tenantOptions },
      cell: ({ row }) =>
        row.original.tenantId ? (
          <NameWithId name={tenantNames.get(row.original.tenantId)} id={row.original.tenantId} />
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
        ),
      size: 180,
    },
    {
      accessorKey: 'scopes',
      header: 'Scopes',
      enableSorting: false,
      meta: { label: 'Scopes', variant: 'select', options: scopeOptions },
      cell: ({ row }) => <ScopeBadges scopes={row.original.scopes} />,
      size: 220,
    },
    {
      accessorKey: 'keyStatus',
      header: 'Status',
      enableSorting: false,
      meta: { label: 'Status', variant: 'multiSelect', options: STATUS_OPTIONS },
      cell: ({ row }) => <KeyStatusBadge apiKey={row.original} />,
      size: 130,
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      enableSorting: false,
      meta: { label: 'Last used' },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.lastUsedAt ? formatRelativeTime(row.original.lastUsedAt) : 'Never'}</span>
      ),
      size: 140,
    },
    {
      id: 'expires',
      header: 'Expires',
      enableSorting: false,
      meta: { label: 'Expires' },
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.expiresAt ? formatDateTime(row.original.expiresAt, 'date') : 'Never'}</span>
      ),
      size: 130,
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      meta: { label: 'Created' },
      cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.createdAt, 'date')}</span>,
      size: 130,
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
          <RowActions apiKey={row.original} onAction={(action) => handleRowAction(row.original, action)} />
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
            title="API keys"
            meta={
              <>
                {data ? <span>{formatNumber(totalCount)} keys</span> : <Skeleton className="h-4 w-16" />}
                <span aria-hidden>&middot;</span>
                <span>secret shown once on create</span>
              </>
            }
            actions={
              <Button onClick={() => setCreateOpen(true)}>
                <IconPlus aria-hidden />
                Create key
              </Button>
            }
          />
        }
        footer={
          <StatusFooter
            start={<span>{isFetching && !isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/api-keys
              </span>
            }
          />
        }
      >
        <AdminDataGrid<ApiKey>
          gridId="api-keys"
          aria-label="API keys"
          columns={columns}
          rows={rows}
          total={totalCount}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          isLoading={isLoading}
          isBusy={isFetching && !isLoading}
          error={error}
          onRetry={() => refetch()}
          emptyState={
            <EmptyState
              icon={IconKey}
              title="No API keys yet"
              description="Create the first key to let services call the platform. The secret is shown once on create."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <IconPlus aria-hidden />
                  Create key
                </Button>
              }
            />
          }
          emptyFilteredState={
            <EmptyState
              icon={IconFilterOff}
              title="No keys match your filters"
              description="Try a different search or clear the filters."
              action={
                <Button variant="outline" onClick={() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] })}>
                  <IconFilterOff aria-hidden />
                  Clear filters
                </Button>
              }
            />
          }
        />
      </ScreenTemplate>
      {createOpen ? (
        <ApiKeyFormDialog
          initial={null}
          onOpenChange={setCreateOpen}
          onCreated={(result) => {
            setCreateOpen(false);
            setRawKey({ rawKey: result.rawKey, keyName: result.apiKey.keyName, mode: 'created' });
          }}
        />
      ) : null}
      {editTarget ? (
        <ApiKeyFormDialog
          key={editTarget.id}
          initial={editTarget}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
        />
      ) : null}
      <ApiKeyUsageSheet
        apiKey={usageTarget}
        onOpenChange={(open) => {
          if (!open) setUsageTarget(null);
        }}
      />
      <RawKeyDialog result={rawKey} onClose={() => setRawKey(null)} />
      <ConfirmDialog
        open={rotateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null);
        }}
        title={`Rotate ${rotateTarget?.keyName ?? 'key'}?`}
        description="A new secret is issued and shown once. The old key keeps working for a 24-hour grace window, then stops — update every consumer before it expires."
        confirmLabel="Rotate key"
        isPending={rotateMutation.isPending}
        onConfirm={confirmRotate}
      />
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={`Revoke ${revokeTarget?.keyName ?? 'key'}?`}
        description="Requests authenticated with this key are rejected immediately. Revocation cannot be undone."
        confirmLabel="Revoke key"
        destructive
        isPending={revokeMutation.isPending}
        onConfirm={confirmRevoke}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete ${deleteTarget?.keyName ?? 'key'}?`}
        description="The key row and its usage history are removed from the console. Active consumers lose access immediately."
        confirmLabel="Delete key"
        destructive
        typeToConfirm={deleteTarget?.keyName}
        isPending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
