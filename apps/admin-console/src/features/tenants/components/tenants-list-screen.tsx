'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconArchive, IconBuildings, IconDots, IconEye, IconFilterOff, IconPlayerPause, IconPlus, IconRestore, IconTrash } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
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
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useTenants } from '../api/hooks';
import type { Tenant } from '../api/types';
import { CreateTenantDialog } from './create-tenant-dialog';
import { PLAN_FILTER_OPTIONS, TenantPlanBadge } from './plan-badge';
import { TenantLifecycleDialogs, type LifecycleAction, type LifecycleRequest } from './tenant-lifecycle-dialogs';

const DEFAULT_SORT = 'updatedAt:desc';
const DEFAULT_LIMIT = 25;

const STATUS_OPTIONS: FilterOption[] = [
    { value: 'ENABLED', label: 'Active' },
    { value: 'SUSPENDED', label: 'Suspended' },
    { value: 'DISABLED', label: 'Disabled' },
    { value: 'ARCHIVED', label: 'Archived' },
];

const SORT_OPTIONS: FilterOption[] = [
    { value: 'name:asc', label: 'Name A\u2013Z' },
    { value: 'name:desc', label: 'Name Z\u2013A' },
    { value: 'createdAt:desc', label: 'Recently created' },
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

/** Frame 12 — Tenants list: filters + sortable table + pagination + wizard. */
export function TenantsListScreen() {
    const router = useRouter();
    const [createOpen, setCreateOpen] = useState(false);
    const [lifecycle, setLifecycle] = useState<LifecycleRequest | null>(null);
    const [{ search, status, plan, sort, page, limit }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        status: parseAsString.withDefault(''),
        plan: parseAsString.withDefault(''),
        sort: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
    });

    const filters = [status && `resourceStatus:${status}`, plan && `plan:${plan}`].filter(Boolean).join(',');
    const listParams: ListParams = {
        page,
        limit,
        sort: sort || DEFAULT_SORT,
        ...(search ? { search, searchFields: 'name,key' } : {}),
        ...(filters ? { filters } : {}),
    };
    const { data, isLoading, error, refetch } = useTenants(listParams);
    const rows = data?.data ?? [];
    const total = data?.count ?? 0;
    const hasFilters = Boolean(search || status || plan);

    const columns: DataTableColumn<Tenant>[] = [
        { key: 'name', header: 'Name', sortKey: 'name', cell: (row) => <span className="font-medium">{row.name}</span> },
        { key: 'key', header: 'Key', mono: true, cell: (row) => row.key },
        { key: 'plan', header: 'Plan', cell: (row) => <TenantPlanBadge plan={row.plan} /> },
        { key: 'status', header: 'Status', cell: (row) => <ResourceStatusBadge status={row.resourceStatus} /> },
        {
            key: 'updated',
            header: 'Updated',
            cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.updatedAt)}</span>,
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => (
                <RowActions
                    tenant={row}
                    onView={() => router.push(`/tenants/${row.id}`)}
                    onAction={(action) => setLifecycle({ action, tenant: row })}
                />
            ),
        },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No tenants match your filters"
            description="Try a different search or clear the filters."
            action={
                <Button variant="outline" onClick={() => setParams({ search: null, status: null, plan: null, page: null })}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
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
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Tenants"
                meta={
                    <>
                        {data ? <span>{formatNumber(total)} tenants</span> : <Skeleton className="h-4 w-20" />}
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/tenants
                        </span>
                    </>
                }
                actions={
                    <Button onClick={() => setCreateOpen(true)}>
                        <IconPlus aria-hidden />
                        New tenant
                    </Button>
                }
            />
            <FilterBar shown={rows.length} total={total}>
                <FilterSearch
                    label="Search tenants"
                    placeholder={'Search tenants\u2026'}
                    value={search}
                    onChange={(value) => setParams({ search: value || null, page: null })}
                />
                <FilterSelect
                    id="tenants-status-filter"
                    label="Status"
                    value={status}
                    onChange={(value) => setParams({ status: value || null, page: null })}
                    options={STATUS_OPTIONS}
                />
                <FilterSelect
                    id="tenants-plan-filter"
                    label="Plan"
                    value={plan}
                    onChange={(value) => setParams({ plan: value || null, page: null })}
                    options={PLAN_FILTER_OPTIONS}
                />
                <FilterSelect
                    id="tenants-sort"
                    label="Sort"
                    value={sort}
                    onChange={(value) => setParams({ sort: value || null })}
                    options={SORT_OPTIONS}
                    allLabel="Recently updated"
                />
            </FilterBar>
            <DataTable
                aria-label="Tenants"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                empty={empty}
                onRowClick={(row) => router.push(`/tenants/${row.id}`)}
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
            <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} />
            <TenantLifecycleDialogs request={lifecycle} onOpenChange={(open) => !open && setLifecycle(null)} />
        </div>
    );
}
