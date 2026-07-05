'use client';

import { useState } from 'react';
import { IconChartBar, IconDots, IconFilterOff, IconKey, IconPencil, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
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
import type { ListParams } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { useApiKeyScopes, useApiKeys, useDeleteApiKey, useRevokeApiKey, useRotateApiKey } from '../api/hooks';
import type { ApiKey } from '../api/types';
import { ApiKeyFormDialog } from './api-key-form-dialog';
import { ApiKeyUsageSheet } from './api-key-usage-sheet';
import { KeyStatusBadge } from './key-status-badge';
import { RawKeyDialog, type RawKeyResult } from './raw-key-dialog';

const DEFAULT_SORT = 'updatedAt:desc';
const DEFAULT_LIMIT = 25;

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
        <span className="flex flex-wrap items-center gap-1">
            {scopes.slice(0, MAX_SCOPE_BADGES).map((scope) => (
                <Badge key={scope} variant="outline" className="font-mono text-[10px]">
                    {scope}
                </Badge>
            ))}
            {scopes.length > MAX_SCOPE_BADGES ? (
                <span className="text-muted-foreground text-xs">+{scopes.length - MAX_SCOPE_BADGES}</span>
            ) : null}
        </span>
    );
}

type RowAction = 'usage' | 'edit' | 'rotate' | 'revoke' | 'delete';

function RowActions({ apiKey, onAction }: { apiKey: ApiKey; onAction: (action: RowAction) => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${apiKey.keyName}`}>
                    <IconDots aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
 * Frame 23 — API keys (/api-keys, tier 20-29 shared). Paginated list with
 * search/status/scope filters (URL-synced), create/edit dialogs, usage
 * drawer, rotate/revoke/delete confirm flows and the one-time raw-key
 * contract: the secret from create or rotate is displayed exactly once.
 */
export function ApiKeysScreen() {
    const [{ q, status, scope, page, limit, sort }, setParams] = useQueryStates({
        q: parseAsString.withDefault(''),
        status: parseAsString.withDefault(''),
        scope: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
        sort: parseAsString.withDefault(''),
    });

    const filters = [status && `keyStatus:${status}`, scope && `scopes:${scope}`].filter(Boolean).join(',');
    const listParams: ListParams = {
        page,
        limit,
        sort: sort || DEFAULT_SORT,
        ...(q ? { search: q, searchFields: 'keyName,keyPrefix' } : {}),
        ...(filters ? { filters } : {}),
    };
    const { data, isLoading, error, refetch } = useApiKeys(listParams);
    const scopesQuery = useApiKeyScopes();
    const rows = data?.data ?? [];
    const total = data?.count ?? 0;
    const hasFilters = Boolean(q || status || scope);

    const scopeOptions: FilterOption[] = Object.values(scopesQuery.data ?? {})
        .flat()
        .map(({ scope: value }) => ({ value, label: value }));

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

    const columns: DataTableColumn<ApiKey>[] = [
        { key: 'name', header: 'Name', sortKey: 'keyName', cell: (row) => <span className="font-medium">{row.keyName}</span> },
        { key: 'prefix', header: 'Prefix', mono: true, cell: (row) => `${row.keyPrefix}\u2026` },
        { key: 'scopes', header: 'Scopes', cell: (row) => <ScopeBadges scopes={row.scopes} /> },
        { key: 'status', header: 'Status', cell: (row) => <KeyStatusBadge apiKey={row} /> },
        {
            key: 'lastUsed',
            header: 'Last used',
            cell: (row) => <span className="text-muted-foreground">{row.lastUsedAt ? formatRelativeTime(row.lastUsedAt) : 'Never'}</span>,
        },
        {
            key: 'expires',
            header: 'Expires',
            cell: (row) => <span className="text-muted-foreground">{row.expiresAt ? formatDateTime(row.expiresAt, 'date') : 'Never'}</span>,
        },
        {
            key: 'created',
            header: 'Created',
            sortKey: 'createdAt',
            cell: (row) => <span className="text-muted-foreground">{formatDateTime(row.createdAt, 'date')}</span>,
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => <RowActions apiKey={row} onAction={(action) => handleRowAction(row, action)} />,
        },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No keys match your filters"
            description="Try a different search or clear the filters."
            action={
                <Button variant="outline" onClick={() => setParams({ q: null, status: null, scope: null, page: null })}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
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
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="API keys"
                meta={
                    <>
                        {data ? <span>{formatNumber(total)} keys</span> : <Skeleton className="h-4 w-16" />}
                        <span aria-hidden>&middot;</span>
                        <span>secret shown once on create</span>
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/api-keys
                        </span>
                    </>
                }
                actions={
                    <Button onClick={() => setCreateOpen(true)}>
                        <IconPlus aria-hidden />
                        Create key
                    </Button>
                }
            />
            <FilterBar shown={rows.length} total={total}>
                <FilterSearch
                    label="Search keys"
                    placeholder={'Search keys\u2026'}
                    value={q}
                    onChange={(value) => setParams({ q: value || null, page: null })}
                />
                <FilterSelect
                    id="api-keys-status"
                    label="Status"
                    value={status}
                    onChange={(value) => setParams({ status: value || null, page: null })}
                    options={STATUS_OPTIONS}
                />
                <FilterSelect
                    id="api-keys-scope"
                    label="Scope"
                    value={scope}
                    onChange={(value) => setParams({ scope: value || null, page: null })}
                    options={scopeOptions}
                />
            </FilterBar>
            <DataTable
                aria-label="API keys"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                empty={empty}
                sort={sort || DEFAULT_SORT}
                onSortChange={(next) => setParams({ sort: next === DEFAULT_SORT ? null : next, page: null })}
            />
            <TablePagination
                page={page}
                limit={limit}
                total={total}
                onPageChange={(next) => setParams({ page: next || null })}
                onLimitChange={(next) => setParams({ limit: next === DEFAULT_LIMIT ? null : next, page: null })}
            />
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
        </div>
    );
}
