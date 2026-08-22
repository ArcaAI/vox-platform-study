'use client';

import { useState } from 'react';
import { IconFilterOff, IconListTree, IconRefresh } from '@tabler/icons-react';
import { parseAsBoolean, parseAsString, useQueryStates } from 'nuqs';
import { useQueryClient } from '@tanstack/react-query';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { workflowRunsKeys, useWorkflowRuns } from '../api';
import type { WorkflowRun } from '../api/types';
import { RunStatusBadge } from './run-status-badge';

const PAGE_SIZE = 25;

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'RUNNING', label: 'Running' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CANCELED', label: 'Canceled' },
  { value: 'TIMED_OUT', label: 'Timed out' },
];

const TRIGGER_OPTIONS: FilterOption[] = [
  { value: 'consultation open', label: 'Consultation open' },
  { value: 'api invoke', label: 'API invoke' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'schedule', label: 'Schedule' },
];

/**
 * Retention alignment (Task 10, `retention-note.md`): `WorkflowRun` rows are
 * cheap (1 row/run) and recommended to outlive `AgentTrajectoryStep` rows
 * (N rows/run, hard-deleted by `AgentTrajectoryRetentionService`, default
 * OFF / 30 days when on). A run's trace can therefore go missing before the
 * run row itself does — the trace screen renders that honestly (see
 * `TracePrunedState`); this footer names the mechanism so it is never a
 * surprise. Static copy, not a live setting read — see README §7 for why.
 */
const RETENTION_FOOTER_NOTE =
  'Run history here outlives per-step traces: trajectory retention (agentic.trajectory.retentionDays, default 30d when enabled) prunes step detail before the run row.';

function WorkflowRunsBody() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [{ workflowSlug, status, trigger, from, to, includeSandbox }, setParams] = useQueryStates({
    workflowSlug: parseAsString.withDefault(''),
    status: parseAsString.withDefault(''),
    trigger: parseAsString.withDefault(''),
    from: parseAsString.withDefault(''),
    to: parseAsString.withDefault(''),
    includeSandbox: parseAsBoolean.withDefault(false),
  });
  const [cursor, setCursor] = useState<string | null>(null);

  const params = {
    workflowSlug: workflowSlug || undefined,
    status: status || undefined,
    trigger: trigger || undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    includeSandbox,
    limit: PAGE_SIZE,
    cursor: cursor ?? undefined,
  };
  const runsQuery = useWorkflowRuns(params);
  const rows = runsQuery.data?.data ?? [];
  const hasFilters = Boolean(workflowSlug || status || trigger || from || to || includeSandbox);

  const queryState: DataQueryState = { pagination: { mode: 'cursor', cursor, limit: PAGE_SIZE }, sorting: [], filters: [], globalSearch: undefined };
  const setQueryState = (next: DataQueryState) => setCursor(next.pagination.mode === 'cursor' ? next.pagination.cursor : null);

  function updateFilters(patch: Partial<{ workflowSlug: string | null; status: string | null; trigger: string | null; from: string | null; to: string | null; includeSandbox: boolean | null }>) {
    setCursor(null);
    void setParams(patch);
  }

  const columns: ColumnDef<WorkflowRun>[] = [
    {
      accessorKey: 'definitionName',
      header: 'Definition',
      meta: { label: 'Definition' },
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="truncate font-medium">{row.original.definitionName}</span>
          <span className="text-muted-foreground font-mono text-xs">
            {row.original.workflowSlug} &middot; v{row.original.workflowVersionNumber}
          </span>
        </div>
      ),
    },
    { accessorKey: 'status', header: 'Status', meta: { label: 'Status' }, cell: ({ row }) => <RunStatusBadge status={row.original.status} /> },
    { accessorKey: 'trigger', header: 'Trigger', meta: { label: 'Trigger' } },
    {
      accessorKey: 'startedAt',
      header: 'Started',
      meta: { label: 'Started' },
      cell: ({ row }) => (
        <span className="whitespace-nowrap" title={formatDateTime(row.original.startedAt)}>
          {formatRelativeTime(row.original.startedAt)}
        </span>
      ),
    },
    {
      accessorKey: 'durationMs',
      header: 'Duration',
      meta: { label: 'Duration' },
      cell: ({ row }) => (row.original.durationMs !== null ? `${formatNumber(row.original.durationMs)} ms` : '—'),
    },
    {
      id: 'nodeCounts',
      header: 'Failed / degraded',
      meta: { label: 'Failed / degraded' },
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {formatNumber(row.original.failedNodeCount)} / {formatNumber(row.original.degradedNodeCount)}
        </span>
      ),
    },
    {
      id: 'sandbox',
      header: 'Sandbox',
      meta: { label: 'Sandbox' },
      cell: ({ row }) => (row.original.isSandbox ? <span className="text-warning-strong text-xs font-medium">Sandbox</span> : null),
    },
  ];

  const emptyState = hasFilters ? (
    <EmptyState
      icon={IconFilterOff}
      title="No runs match the filter"
      description="Try widening the date range or clearing a filter."
      action={
        <Button variant="outline" onClick={() => updateFilters({ workflowSlug: null, status: null, trigger: null, from: null, to: null, includeSandbox: null })} aria-label="Clear filters and show all rows">
          <IconFilterOff aria-hidden />
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={IconListTree}
      title="No workflow runs yet"
      description="Runs appear here once TASK-718's interpreter dispatches a workflow-substrate execution for this tenant."
    />
  );

  return (
    <ScreenTemplate
      contentMode="fill"
      header={
        <PageHeader
          title="Workflow Runs"
          meta={
            <>
              {runsQuery.data ? <span>{formatNumber(rows.length)} runs shown</span> : <Skeleton className="h-4 w-32" />}
              <span>Definition-scoped &middot; tenant view</span>
              <Link href="/ai-operations/runs" className="text-foreground underline underline-offset-2">
                See all agentic runs (cross-tenant platform ops) →
              </Link>
            </>
          }
          actions={
            <Button variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: workflowRunsKeys.root })}>
              <IconRefresh aria-hidden />
              Refresh
            </Button>
          }
        />
      }
      toolbar={
        <FilterBar shown={rows.length} total={rows.length}>
          <FilterSearch
            label="Filter by definition slug"
            placeholder={'Definition slug…'}
            value={workflowSlug}
            onChange={(value) => updateFilters({ workflowSlug: value || null })}
          />
          <FilterSelect
            id="runs-status-filter"
            label="Status"
            value={status}
            onChange={(value) => updateFilters({ status: value || null })}
            options={STATUS_OPTIONS}
          />
          <FilterSelect
            id="runs-trigger-filter"
            label="Trigger"
            value={trigger}
            onChange={(value) => updateFilters({ trigger: value || null })}
            options={TRIGGER_OPTIONS}
          />
          <div className="flex items-center gap-1.5">
            <Label htmlFor="runs-from" className="text-muted-foreground text-sm font-normal">
              From
            </Label>
            <Input id="runs-from" type="date" className="h-9 w-36" value={from} onChange={(event) => updateFilters({ from: event.target.value || null })} />
          </div>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="runs-to" className="text-muted-foreground text-sm font-normal">
              To
            </Label>
            <Input id="runs-to" type="date" className="h-9 w-36" value={to} onChange={(event) => updateFilters({ to: event.target.value || null })} />
          </div>
          <div className="flex items-center gap-1.5">
            <Switch
              id="runs-include-sandbox"
              checked={includeSandbox}
              onCheckedChange={(checked) => updateFilters({ includeSandbox: checked || null })}
            />
            <Label htmlFor="runs-include-sandbox" className="text-muted-foreground text-sm font-normal">
              Include sandbox runs
            </Label>
          </div>
        </FilterBar>
      }
      footer={
        <StatusFooter
          start={<span>{RETENTION_FOOTER_NOTE}</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/workflow-runs
            </span>
          }
        />
      }
    >
      <VirtualizedDataGrid<WorkflowRun>
        aria-label="Workflow runs"
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        persistence={gridPersistence('workflow-runs')}
        manual={{ pagination: true }}
        rowCount={rows.length}
        pageMode="cursor"
        cursor={{ hasMore: Boolean(runsQuery.data?.hasMore), nextCursor: runsQuery.data?.nextCursor ?? undefined }}
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
        isLoading={runsQuery.isLoading}
        isBusy={runsQuery.isFetching && !runsQuery.isLoading}
        error={runsQuery.error}
        onRetry={() => void runsQuery.refetch()}
        errorState={(err) => <ErrorState error={err} onRetry={() => void runsQuery.refetch()} />}
        emptyState={emptyState}
        // `:runId` on `GET /admin/workflow-runs/:runId` is `WorkflowRun.runId`
        // (the domain run id the controller's `findRunOrThrow` looks up by),
        // never the row's own `id` primary key.
        onRowClick={(row) => router.push(`/workflow-runs/${encodeURIComponent(row.runId)}`)}
      />
    </ScreenTemplate>
  );
}

/** Frame N — Workflow Runs list (tier 30-49). Definition-scoped tenant view; cross-links `/ai-operations/runs` (§2.4). */
export function WorkflowRunsScreen() {
  return (
    <WorkingTenantGate
      title="Workflow Runs"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/workflow-runs
        </span>
      }
      description="Workflow runs are tenant-scoped. Pick a working tenant from the top-bar switcher to load its runs."
    >
      <WorkflowRunsBody />
    </WorkingTenantGate>
  );
}
