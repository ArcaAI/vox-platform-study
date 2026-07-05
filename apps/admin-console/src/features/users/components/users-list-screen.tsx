'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconDots, IconEye, IconFilterOff, IconKey, IconPlus, IconTrash, IconUserCheck, IconUserOff, IconUsers } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { GatewayError, type ListParams } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useBulkDeleteUsers, useBulkUserAction, useUsers } from '../api/hooks';
import type { User, UserRoleAssignment } from '../api/types';
import { CreateUserDialog } from './create-user-dialog';
import { UserActionDialogs, type UserActionRequest } from './user-action-dialogs';
import { UserAvatar } from './user-avatar';

const DEFAULT_SORT = 'createdAt:desc';
const DEFAULT_LIMIT = 25;
const ROLE_CHIP_LIMIT = 2;

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

/** Role chips truncate at +N per frame 20; absent on payloads without roles. */
function RolesCell({ assignments }: { assignments?: UserRoleAssignment[] }) {
    if (!assignments?.length) return <span className="text-muted-foreground">{'\u2014'}</span>;
    const shown = assignments.slice(0, ROLE_CHIP_LIMIT);
    const extra = assignments.length - shown.length;
    return (
        <span className="flex flex-wrap items-center gap-1">
            {shown.map((assignment) => (
                <Badge key={assignment.id} variant="secondary">
                    {assignment.roleName ?? assignment.roleId}
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

const BULK_COPY: Record<BulkAction, { title: (count: number) => string; description: string; confirmLabel: string; destructive: boolean; success: string }> = {
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

/** Frame 20 — Users list: filters + sortable table + bulk actions + pagination. */
export function UsersListScreen() {
    const router = useRouter();
    const [createOpen, setCreateOpen] = useState(false);
    const [action, setAction] = useState<UserActionRequest | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [bulk, setBulk] = useState<BulkAction | null>(null);
    const bulkAction = useBulkUserAction();
    const bulkDelete = useBulkDeleteUsers();
    const [{ search, status, type, sort, page, limit }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        status: parseAsString.withDefault(''),
        type: parseAsString.withDefault(''),
        sort: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
    });

    const filters = [status && `resourceStatus:${status}`, type && `isServiceAccount:${type}`].filter(Boolean).join(',');
    const listParams: ListParams = {
        page,
        limit,
        sort: sort || DEFAULT_SORT,
        ...(search ? { search, searchFields: 'username,externalId' } : {}),
        ...(filters ? { filters } : {}),
    };
    const { data, isLoading, error, refetch } = useUsers(listParams);
    const rows = data?.data ?? [];
    const total = data?.count ?? 0;
    const hasFilters = Boolean(search || status || type);
    const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));

    function toggleRow(id: string, checked: boolean) {
        setSelected((prev) => (checked ? [...prev, id] : prev.filter((existing) => existing !== id)));
    }

    function finishBulk(succeeded: number, failed: number) {
        const copy = BULK_COPY[bulk as BulkAction];
        if (failed > 0) {
            toast.error(`${succeeded} of ${succeeded + failed} users ${copy.success} \u2014 ${failed} failed`);
        } else {
            toast.success(`${succeeded} user${succeeded === 1 ? '' : 's'} ${copy.success}`);
        }
        setSelected([]);
        setBulk(null);
    }

    function handleBulkConfirm() {
        if (!bulk) return;
        if (bulk === 'delete') {
            bulkDelete.mutate(selected, {
                onSuccess: (result) => finishBulk(result.succeeded.length, result.failed.length),
                onError: (mutationError) => toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Bulk delete failed.'),
            });
            return;
        }
        bulkAction.mutate(
            { action: bulk, ids: selected },
            {
                onSuccess: (result) => finishBulk(result.succeeded, result.failed),
                onError: (mutationError) => toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Bulk action failed.'),
            },
        );
    }

    const columns: DataTableColumn<User>[] = [
        {
            key: 'select',
            header: (
                <Checkbox
                    aria-label="Select all users on this page"
                    checked={allSelected ? true : selected.length > 0 ? 'indeterminate' : false}
                    onCheckedChange={(checked) => setSelected(checked === true ? rows.map((row) => row.id) : [])}
                />
            ),
            headerClassName: 'w-10',
            className: 'w-10',
            cell: (row) => (
                <Checkbox
                    aria-label={`Select ${row.username}`}
                    checked={selected.includes(row.id)}
                    onCheckedChange={(checked) => toggleRow(row.id, checked === true)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                />
            ),
        },
        {
            key: 'user',
            header: 'User',
            sortKey: 'username',
            cell: (row) => (
                <span className="flex items-center gap-2">
                    <UserAvatar username={row.username} size="sm" />
                    <span className="font-medium">{row.username}</span>
                    {row.isServiceAccount ? <Badge variant="outline">Service account</Badge> : null}
                </span>
            ),
        },
        { key: 'roles', header: 'Roles', cell: (row) => <RolesCell assignments={row.UserRoleAssignments} /> },
        { key: 'status', header: 'Status', cell: (row) => <ResourceStatusBadge status={row.resourceStatus} /> },
        {
            key: 'lastActive',
            header: 'Last active',
            sortKey: 'lastActiveAt',
            cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.lastActiveAt ?? row.lastLoginAt)}</span>,
        },
        {
            key: 'created',
            header: 'Created',
            sortKey: 'createdAt',
            cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.createdAt)}</span>,
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => (
                <RowActions
                    user={row}
                    onView={() => router.push(`/users/${row.id}`)}
                    onAction={(rowAction) => setAction({ action: rowAction, user: row })}
                />
            ),
        },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No users match your filters"
            description="Try a different search or clear the filters."
            action={
                <Button variant="outline" onClick={() => setParams({ search: null, status: null, type: null, page: null })}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
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
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Users"
                meta={
                    <>
                        {data ? <span>{formatNumber(total)} users</span> : <Skeleton className="h-4 w-16" />}
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/users
                        </span>
                    </>
                }
                actions={
                    <Button onClick={() => setCreateOpen(true)}>
                        <IconPlus aria-hidden />
                        New user
                    </Button>
                }
            />
            <FilterBar shown={rows.length} total={total}>
                <FilterSearch
                    label="Search users"
                    placeholder={'Search username or external ID\u2026'}
                    value={search}
                    onChange={(value) => setParams({ search: value || null, page: null })}
                />
                <FilterSelect
                    id="users-status-filter"
                    label="Status"
                    value={status}
                    onChange={(value) => setParams({ status: value || null, page: null })}
                    options={STATUS_OPTIONS}
                />
                <FilterSelect
                    id="users-type-filter"
                    label="Type"
                    value={type}
                    onChange={(value) => setParams({ type: value || null, page: null })}
                    options={TYPE_OPTIONS}
                />
            </FilterBar>
            {selected.length > 0 ? (
                <div role="toolbar" aria-label="Bulk actions" className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <span className="px-1 text-sm font-medium" aria-live="polite">
                        {selected.length} selected
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
                    <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected([])}>
                        Clear selection
                    </Button>
                </div>
            ) : null}
            <DataTable
                aria-label="Users"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                empty={empty}
                onRowClick={(row) => router.push(`/users/${row.id}`)}
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
            <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
            <UserActionDialogs request={action} onOpenChange={(open) => !open && setAction(null)} />
            {bulk ? (
                <ConfirmDialog
                    open
                    onOpenChange={(open) => !open && setBulk(null)}
                    title={BULK_COPY[bulk].title(selected.length)}
                    description={BULK_COPY[bulk].description}
                    confirmLabel={BULK_COPY[bulk].confirmLabel}
                    destructive={BULK_COPY[bulk].destructive}
                    isPending={bulkAction.isPending || bulkDelete.isPending}
                    onConfirm={handleBulkConfirm}
                />
            ) : null}
        </div>
    );
}
