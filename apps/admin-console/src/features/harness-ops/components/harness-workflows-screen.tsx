'use client';

import { useState } from 'react';
import { IconFilterOff, IconRefresh, IconTopologyStar3 } from '@tabler/icons-react';
import { parseAsString, useQueryStates } from 'nuqs';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { CursorPagination } from '@/shared/data/table-pagination';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
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
    const [cursorStack, setCursorStack] = useState<string[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const cursor = cursorStack.at(-1);
    const workflowsQuery = useHarnessWorkflows({
        status: state || undefined,
        limit: PAGE_SIZE,
        pageToken: cursor,
    });

    const items = workflowsQuery.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    const rows = items.filter((workflow) => {
        if (type && workflowKind(workflow.workflowId) !== type) return false;
        if (!needle) return true;
        return workflow.workflowId.toLowerCase().includes(needle) || (workflow.consultationId ?? '').toLowerCase().includes(needle);
    });
    const hasFilters = Boolean(search || state || type);

    /** Any filter change restarts the Temporal cursor walk from the first page. */
    function updateFilters(patch: Parameters<typeof setParams>[0]) {
        setCursorStack([]);
        void setParams(patch);
    }

    const columns: DataTableColumn<HarnessWorkflowSummary>[] = [
        {
            key: 'workflow',
            header: 'Workflow',
            mono: true,
            cell: (row) => (
                <span className="block max-w-56 truncate" title={row.workflowId}>
                    {row.workflowId}
                </span>
            ),
        },
        { key: 'type', header: 'Type', cell: (row) => workflowKind(row.workflowId) },
        { key: 'state', header: 'State', cell: (row) => <WorkflowStatusBadge status={row.status} /> },
        {
            key: 'started',
            header: 'Started',
            cell: (row) => (
                <span className="whitespace-nowrap" title={row.startedAt ? `${formatDateTime(row.startedAt)} (local)` : undefined}>
                    {formatRelativeTime(row.startedAt)}
                </span>
            ),
        },
    ];

    const empty = hasFilters ? (
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
                    <DataTable
                        aria-label="Harness workflows"
                        columns={columns}
                        rows={rows}
                        rowKey={(row) => row.workflowId}
                        isLoading={workflowsQuery.isLoading}
                        error={workflowsQuery.error}
                        onRetry={() => void workflowsQuery.refetch()}
                        empty={empty}
                        onRowClick={(row) => setSelectedId(row.workflowId)}
                    />
                    <CursorPagination
                        hasPrev={cursorStack.length > 0}
                        hasNext={Boolean(workflowsQuery.data?.nextPageToken)}
                        onPrev={() => setCursorStack((stack) => stack.slice(0, -1))}
                        onNext={() => {
                            const next = workflowsQuery.data?.nextPageToken;
                            if (next) setCursorStack((stack) => [...stack, next]);
                        }}
                        shownCount={rows.length}
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
