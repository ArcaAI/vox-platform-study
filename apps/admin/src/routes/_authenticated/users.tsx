import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { toPaginatedQuery, type DataQueryState } from '@arcaai/ui/lib/shared';
import { useUsers } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { ResponsiveDataGrid } from '@/features/data-grid/responsive-data-grid';
import { RESOURCE_STATUS_OPTIONS, resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { useGridLayoutPersistence } from '@/features/data-grid/use-grid-persistence';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { NoTenantState } from '@/features/tenants/tenant-context';
import { toUserListQuery } from '@/features/users/user-query';
import { GRID_LAYOUT_NAMESPACE } from '@/lib/constants';
import { initialsOf } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';

export const Route = createFileRoute('/_authenticated/users')({
    component: UsersPage,
});

type UserRow = ReturnType<typeof useUsers>['users'][number];

const PAGE_SIZE_OPTIONS = [10, 20, 50];

const ACCOUNT_TYPE_OPTIONS = [
    { label: 'User', value: 'false' },
    { label: 'Service account', value: 'true' },
];

const INITIAL_QUERY_STATE: DataQueryState = {
    pagination: { mode: 'offset', page: 0, limit: 20 },
    sorting: [{ id: 'username', desc: false }],
    filters: [],
};

function UsersPage() {
    const { listPaginated } = useUsers();
    const adapter = useGridLayoutPersistence();
    const roles = useAuthStore((s) => s.user?.roles);
    const tenantId = useAuthStore((s) => s.tenantId);
    // GAP-ADM-001: don't show all users cross-tenant; a super-admin in "All tenants"
    // mode must select a working tenant first. Tenant-admins are always scoped.
    const noTenant = isSuperAdmin(roles) && !tenantId;

    const [rows, setRows] = useState<UserRow[]>([]);
    const [total, setTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [queryState, setQueryState] = useState<DataQueryState>(INITIAL_QUERY_STATE);

    // DataQueryState → backend PaginatedQuery CSV (filters/sort/search) (TASK-374).
    const serialized = useMemo(() => toPaginatedQuery(queryState), [queryState]);
    const serializedKey = useMemo(() => JSON.stringify(serialized), [serialized]);

    const fetchPage = useCallback(() => {
        // NoTenant gate (GAP-ADM-001): skip the cross-tenant fetch entirely.
        if (noTenant) {
            setRows([]);
            setTotal(0);
            setIsLoading(false);
            return;
        }
        setIsLoading(true);
        setError(null);
        // …→ toUserListQuery → useUsers().listPaginated. The SDK forwards the full
        // PaginatedQuery; if the backend ignores sort/filter it still returns the
        // page, so the grid degrades gracefully to offset-only behavior.
        listPaginated(toUserListQuery(queryState.pagination, serialized))
            .then((res) => {
                setRows(res.data);
                setTotal(res.total);
            })
            .catch((err) => setError(err instanceof Error ? err : new Error(String(err))))
            .finally(() => setIsLoading(false));
    }, [listPaginated, queryState.pagination, serialized, noTenant]);

    useEffect(() => {
        fetchPage();
        // Re-fetch when the serialized server query OR the working tenant changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serializedKey, tenantId]);

    // Reset to the first page whenever the result-set shape changes
    // (sort / filter / search / page-size), keeping explicit page navigation.
    const onQueryStateChange = useCallback((next: DataQueryState) => {
        setQueryState((prev) => {
            const shapeChanged =
                JSON.stringify(prev.sorting) !== JSON.stringify(next.sorting) ||
                JSON.stringify(prev.filters) !== JSON.stringify(next.filters) ||
                (prev.globalSearch ?? '') !== (next.globalSearch ?? '') ||
                prev.pagination.limit !== next.pagination.limit;
            if (shapeChanged && next.pagination.mode === 'offset') {
                return { ...next, pagination: { ...next.pagination, page: 0 } };
            }
            return next;
        });
    }, []);

    const columns = useMemo<ColumnDef<UserRow>[]>(
        () => [
            {
                accessorKey: 'username',
                header: 'Username',
                meta: { label: 'Username' },
                cell: ({ getValue }) => <span className="truncate font-medium">{getValue() as string}</span>,
            },
            {
                accessorKey: 'email',
                header: 'Email',
                meta: { label: 'Email' },
                cell: ({ getValue }) => <span className="truncate text-muted-foreground">{(getValue() as string) || '—'}</span>,
            },
            {
                accessorKey: 'resourceStatus',
                header: 'Status',
                meta: { label: 'Status', variant: 'multiSelect', options: RESOURCE_STATUS_OPTIONS },
                size: 130,
                cell: ({ getValue }) => {
                    const status = getValue() as string | undefined;
                    return <StatusBadge label={resourceStatusLabel(status)} colorRole={resourceStatusRole(status)} />;
                },
            },
            {
                accessorKey: 'isServiceAccount',
                header: 'Type',
                meta: { label: 'Type', variant: 'multiSelect', options: ACCOUNT_TYPE_OPTIONS },
                size: 160,
                cell: ({ getValue }) =>
                    getValue() ? (
                        <StatusBadge label="Service account" colorRole="info" />
                    ) : (
                        <span className="text-sm text-muted-foreground">User</span>
                    ),
            },
            {
                accessorKey: 'id',
                header: 'ID',
                enableSorting: false,
                meta: { label: 'ID' },
                cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue() as string}</span>,
            },
        ],
        [],
    );

    if (noTenant) {
        return (
            <div>
                <PageHeader
                    title="Users"
                    description="People and service accounts in your tenant — searched, filtered, sorted and paginated server-side. Column layout and density persist to your profile."
                />
                <NoTenantState resource="users" />
            </div>
        );
    }

    return (
        <div>
            <PageHeader
                title="Users"
                description="People and service accounts in your tenant — searched, filtered, sorted and paginated server-side. Column layout and density persist to your profile."
            />
            <ResponsiveDataGrid<UserRow>
                aria-label="Users"
                data={rows}
                columns={columns}
                getRowId={(u) => u.id}
                manual={{ pagination: true, sorting: true, filtering: true }}
                rowCount={total}
                queryState={queryState}
                onQueryStateChange={onQueryStateChange}
                features={{ sorting: true, globalSearch: true, facetedFilters: true }}
                isLoading={isLoading && rows.length === 0}
                error={error ?? undefined}
                onRetry={fetchPage}
                height={560}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                persistence={{ key: 'users', namespace: GRID_LAYOUT_NAMESPACE, adapter }}
                condensedColumnIds={['username', 'email', 'resourceStatus']}
                mobileSearchPlaceholder="Search users…"
                mobileCard={(u) => ({
                    id: u.id,
                    avatar: (
                        <Avatar className="size-10">
                            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">{initialsOf(u.username)}</AvatarFallback>
                        </Avatar>
                    ),
                    title: u.username,
                    subtitle: u.email || '—',
                    badge: <StatusBadge label={resourceStatusLabel(u.resourceStatus)} colorRole={resourceStatusRole(u.resourceStatus)} />,
                    meta: u.isServiceAccount ? 'Service account' : undefined,
                })}
            />
        </div>
    );
}
