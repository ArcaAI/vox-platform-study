'use client';

import { useMemo, useState } from 'react';
import { IconFilterOff, IconRefresh, IconTopologyStar3 } from '@tabler/icons-react';
import { parseAsString, useQueryStates } from 'nuqs';
import { useQueryClient } from '@tanstack/react-query';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { harnessOpsKeys, useHarnessWorkflows } from '../api';
import type { HarnessWorkflowSummary } from '../api';
import { SignalsLifecyclePanel } from './signals-lifecycle-panel';
import { WorkflowDetailDrawer } from './workflow-detail-drawer';
import { WORKFLOW_KINDS, workflowKind } from './workflow-kind';
import { WorkflowStatusBadge } from './workflow-status-badge';

const PAGE_SIZE = 25;

/** Temporal statuses the list endpoint accepts as its `status` filter. */
const STATE_OPTIONS: FilterOption[] = [
    { value: 'RUNNING', label: 'Running' },
    { value: 'COMPLETED', label: 'Completed' },
    { value: 'FAILED', label: 'Failed' },
    { value: 'CANCELED', label: 'Canceled' },
    { value: 'TERMINATED', label: 'Terminated' },
    { value: 'TIMED_OUT', label: 'Timed out' },
    { value: 'CONTINUED_AS_NEW', label: 'Continued as new' },
];

/** No server type param exists — the kind filter is client-side over the page. */
const TYPE_OPTIONS: FilterOption[] = WORKFLOW_KINDS.map((kind) => ({ value: kind, label: kind }));

function WorkflowsBody() {
    const queryClient = useQueryClient();
    const [{ search, state, type }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        state: parseAsString.withDefault(''),
        type: parseAsString.withDefault(''),
    });
    // The Temporal cursor is ephemeral local state; the grid's cursor pager walks
    // it via `queryState`, while search/type stay client-side over the loaded page.
    const [cursor, setCursor] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const workflowsQuery = useHarnessWorkflows({
        status: state || undefined,
        limit: PAGE_SIZE,
        pageToken: cursor ?? undefined,
    });

    const items = workflowsQuery.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    const rows = items.filter((workflow) => {
        if (type && workflowKind(workflow.workflowId) !== type) return false;
        if (!needle) return true;
        return workflow.workflowId.toLowerCase().includes(needle) || (workflow.consultationId ?? '').toLowerCase().includes(needle);
    });
    const hasFilters = Boolean(search || state || type);

    const queryState = useMemo<DataQueryState>(
        () => ({ pagination: { mode: 'cursor', cursor, limit: PAGE_SIZE }, sorting: [], filters: [], globalSearch: undefined }),
        [cursor],
    );
    /** The grid's cursor pager drives prev/next by writing the visited token here. */
    const setQueryState = (next: DataQueryState) => setCursor(next.pagination.mode === 'cursor' ? next.pagination.cursor : null);

    /** Any filter change restarts the Temporal cursor walk from the first page. */
    function updateFilters(patch: Parameters<typeof setParams>[0]) {
        setCursor(null);
        void setParams(patch);
    }

    const columns: ColumnDef<HarnessWorkflowSummary>[] = [
        {
            accessorKey: 'workflowId',
            header: 'Workflow',
            meta: { label: 'Workflow' },
            cell: ({ row }) => (
                <span className="block max-w-56 truncate font-mono text-xs" title={row.original.workflowId}>
                    {row.original.workflowId}
                </span>
            ),
        },
        { id: 'type', accessorFn: (row) => workflowKind(row.workflowId), header: 'Type', meta: { label: 'Type' }, cell: ({ row }) => workflowKind(row.original.workflowId) },
        { accessorKey: 'status', header: 'State', meta: { label: 'State' }, cell: ({ row }) => <WorkflowStatusBadge status={row.original.status} /> },
        {
            accessorKey: 'startedAt',
            header: 'Started',
            meta: { label: 'Started' },
            cell: ({ row }) => (
                <span className="whitespace-nowrap" title={row.original.startedAt ? `${formatDateTime(row.original.startedAt)} (local)` : undefined}>
                    {formatRelativeTime(row.original.startedAt)}
                </span>
            ),
        },
    ];

    const emptyState = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No workflows match the filter"
            description="The id search and type filter only cover the loaded page; the state filter is applied by Temporal."
            action={
                <Button variant="outline" onClick={() => updateFilters({ search: null, state: null, type: null })}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
        <EmptyState
            icon={IconTopologyStar3}
            title="No harness workflows"
            description="Temporal document workflows appear here as consultations run through the harness."
        />
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Harness Workflows"
                meta={
                    <>
                        {workflowsQuery.data ? (
                            <span>{formatNumber(rows.length)} workflows shown</span>
                        ) : (
                            <Skeleton className="h-4 w-32" />
                        )}
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/harness/workflows
                        </span>
                        <span>Temporal-backed via apps/harness through the gateway</span>
                    </>
                }
                actions={
                    <Button variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: harnessOpsKeys.root })}>
                        <IconRefresh aria-hidden />
                        Refresh
                    </Button>
                }
            />
            <FilterBar shown={rows.length} total={items.length}>
                <FilterSearch
                    label="Search workflow id"
                    placeholder={'Search workflow id\u2026'}
                    value={search}
                    onChange={(value) => updateFilters({ search: value || null })}
                />
                <FilterSelect
                    id="workflows-state-filter"
                    label="State"
                    value={state}
                    onChange={(value) => updateFilters({ state: value || null })}
                    options={STATE_OPTIONS}
                />
                <FilterSelect
                    id="workflows-type-filter"
                    label="Type"
                    value={type}
                    onChange={(value) => updateFilters({ type: value || null })}
                    options={TYPE_OPTIONS}
                />
            </FilterBar>
            <div className="grid gap-4 xl:grid-cols-4">
                <WorkflowDetailDrawer workflowId={selectedId} />
                <div className="flex min-w-0 flex-col gap-3 xl:col-span-2">
                    {/* The grid stays mounted across filter changes so its per-user
                        persisted column layout loads once (no skeleton/layout flash).
                        A filter change resets the Temporal cursor to page 1 in
                        `updateFilters`; the forward-only cursor walk is preserved. */}
                    <VirtualizedDataGrid<HarnessWorkflowSummary>
                        aria-label="Harness workflows"
                        columns={columns}
                        data={rows}
                        getRowId={(row) => row.workflowId}
                        height={480}
                        persistence={gridPersistence('harness-workflows')}
                        manual={{ pagination: true }}
                        rowCount={rows.length}
                        pageMode="cursor"
                        cursor={{ hasMore: Boolean(workflowsQuery.data?.nextPageToken), nextCursor: workflowsQuery.data?.nextPageToken }}
                        queryState={queryState}
                        onQueryStateChange={setQueryState}
                        features={{
                            columnReorder: true,
                            columnResize: true,
                            columnPinning: true,
                            columnVisibility: true,
                            rowSelection: false,
                            globalSearch: false,
                            facetedFilters: false,
                            sorting: false,
                        }}
                        isLoading={workflowsQuery.isLoading}
                        isBusy={workflowsQuery.isFetching && !workflowsQuery.isLoading}
                        error={workflowsQuery.error}
                        onRetry={() => void workflowsQuery.refetch()}
                        errorState={(err) => <ErrorState error={err} onRetry={() => void workflowsQuery.refetch()} />}
                        emptyState={emptyState}
                        onRowClick={(row) => setSelectedId(row.workflowId)}
                    />
                </div>
                <SignalsLifecyclePanel workflowId={selectedId} />
            </div>
        </div>
    );
}

/** Frame 38 — Harness workflows: Temporal observe + operate (tier 30–49). */
export function HarnessWorkflowsScreen() {
    return (
        <WorkingTenantGate
            title="Harness Workflows"
            meta={
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET /admin/harness/workflows
                </span>
            }
            description="Harness workflows are tenant-scoped. Pick a working tenant from the switcher in the top bar to load its Temporal document workflows."
        >
            <WorkflowsBody />
        </WorkingTenantGate>
    );
}
