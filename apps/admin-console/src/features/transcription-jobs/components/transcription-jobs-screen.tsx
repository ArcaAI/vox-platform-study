'use client';

import { useMemo, useState } from 'react';
import { IconFilterOff, IconInbox, IconRefresh } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { transcriptionJobKeys, useTranscriptionJobStats, useTranscriptionJobs, useTranscriptionJobsByStatus } from '../api';
import type { TranscriptionJob, TranscriptionJobStats, TranscriptionJobStatus } from '../api';
import { JOB_STATUS_META, TranscriptionJobStatusBadge } from './job-status-badge';
import { JobStreamCard } from './job-stream-panel';

const JOB_STATUSES = ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'] as const;

const STATUS_OPTIONS: FilterOption[] = JOB_STATUSES.map((status) => ({ value: status, label: JOB_STATUS_META[status].label }));

/** Embedded grid (design-spec D2): fixed viewport beside the live-stream panel. */
const JOBS_GRID_HEIGHT = 480;

/** Read a single-select faceted filter's scalar value out of the grid query-state. */
function selectValue(state: DataQueryState, id: string): string {
  const rule = state.filters.find((filter) => filter.id === id);
  if (!rule) return '';
  return Array.isArray(rule.value) ? String(rule.value[0] ?? '') : String(rule.value ?? '');
}

const ENDPOINT_HINT = (
  <span aria-hidden className="font-mono text-xs">
    GET /admin/audio/transcription-jobs
  </span>
);

/** Wall-clock runtime "mm:ss" (or "h:mm:ss"); em-dash before the job starts. */
function formatJobDuration(job: TranscriptionJob, now: number = Date.now()): string {
  if (!job.startedAt) return '\u2014';
  const start = new Date(job.startedAt).getTime();
  const end = job.completedAt ? new Date(job.completedAt).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '\u2014';
  const totalSeconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function statsTotal(stats: TranscriptionJobStats): number {
  return stats.queued + stats.processing + stats.completed + stats.failed + stats.cancelled + stats.dead;
}

/** Frame 35 — Transcription Jobs (tier 30–49): read-only ops surface. */
export function TranscriptionJobsScreen() {
  return (
    <WorkingTenantGate title="Transcription Jobs" meta={ENDPOINT_HINT}>
      <TranscriptionJobsBody />
    </WorkingTenantGate>
  );
}

function TranscriptionJobsBody() {
  const queryClient = useQueryClient();
  // Omni search (client id-substring) + the Status faceted filter live in the
  // URL via the standard grid codec; the selected row (a stream panel, not a
  // route) stays local state.
  const query = useAdminGridParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const search = query.queryState.globalSearch?.trim().toLowerCase() ?? '';
  const statusValue = selectValue(query.queryState, 'status');
  const status = (JOB_STATUSES as readonly string[]).includes(statusValue) ? (statusValue as TranscriptionJobStatus) : null;
  const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
  const limit = query.queryState.pagination.limit;

  const statsQuery = useTranscriptionJobStats();
  // The gateway list is 1-based; the URL keeps the 0-based house convention.
  const listQuery = useTranscriptionJobs({ page: page + 1, limit }, status === null);
  const statusQuery = useTranscriptionJobsByStatus(status);

  const activeQuery = status !== null ? statusQuery : listQuery;
  const { rows: listRows, total: listTotal } = normalizeList<TranscriptionJob>(listQuery.data);
  const loaded: TranscriptionJob[] = status !== null ? (statusQuery.data ?? []) : listRows;
  const filtered = search ? loaded.filter((job) => job.id.toLowerCase().includes(search)) : loaded;

  // Status mode loads EVERY row for the status → client-paginate here; list mode
  // is already server-paged, so its (search-narrowed) page is shown as-is.
  const total = status !== null ? filtered.length : (listTotal ?? 0);
  const rows = status !== null ? filtered.slice(page * limit, page * limit + limit) : filtered;
  const hasFilters = Boolean(search || status);

  const stats = statsQuery.data;
  const statsLoading = statsQuery.isPending || (statsQuery.isError && statsQuery.isFetching);

  function applyFailedFilter() {
    setSelectedId(null);
    query.setQueryState({ ...query.queryState, filters: [{ id: 'status', operator: 'eq', value: 'FAILED', variant: 'select' }] });
  }

  function handleRefresh() {
    void queryClient.invalidateQueries({ queryKey: transcriptionJobKeys.root });
  }

  const clearFilters = () => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] });

  const columns = useMemo<ColumnDef<TranscriptionJob>[]>(
    () => [
      {
        accessorKey: 'id',
        header: 'Job',
        enableSorting: false,
        enableHiding: false,
        size: 200,
        minSize: 140,
        meta: { label: 'Job' },
        cell: ({ row }) => (
          <span
            className={`block max-w-48 truncate font-mono text-xs ${row.original.id === selectedId ? 'text-primary font-semibold' : ''}`}
            title={row.original.id}
          >
            {row.original.id}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        enableSorting: false,
        enableHiding: false,
        size: 130,
        meta: { label: 'Status', variant: 'select', options: STATUS_OPTIONS },
        cell: ({ row }) => <TranscriptionJobStatusBadge status={row.original.status} />,
      },
      {
        id: 'duration',
        header: 'Dur.',
        enableSorting: false,
        enableHiding: false,
        size: 90,
        meta: { label: 'Dur.' },
        cell: ({ row }) => <span className="tabular-nums">{formatJobDuration(row.original)}</span>,
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        enableSorting: false,
        enableHiding: false,
        size: 130,
        meta: { label: 'Updated' },
        cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.updatedAt)}</span>,
      },
    ],
    [selectedId],
  );

  const empty = hasFilters ? (
    <EmptyState
      icon={IconFilterOff}
      title="No jobs in range"
      description="Filter mismatch — try a different search or clear the filters."
      action={
        <Button variant="outline" onClick={clearFilters}>
          <IconFilterOff aria-hidden />
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={IconInbox}
      title="No transcription jobs yet"
      description="Jobs appear here as the SDK plane submits audio for this tenant. This surface is read-only."
    />
  );

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Transcription Jobs"
          meta={
            <>
              {stats ? <span>{formatNumber(statsTotal(stats))} jobs</span> : <Skeleton className="h-4 w-16" />}
              <span className="text-xs">read-only ops surface {'\u2014'} job creation = SDK plane (TASK-420)</span>
            </>
          }
          actions={
            <Button variant="outline" onClick={handleRefresh}>
              <IconRefresh aria-hidden />
              Refresh {'\u00b7'} 30 s
            </Button>
          }
        />
      }
      stats={
        <section aria-label="Job status counts" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Queued" value={stats ? formatNumber(stats.queued) : null} accent="default" isLoading={statsLoading} />
          <StatCard label="Running" value={stats ? formatNumber(stats.processing) : null} accent="primary" isLoading={statsLoading} />
          <StatCard label="Completed" value={stats ? formatNumber(stats.completed) : null} accent="success" isLoading={statsLoading} />
          {/* Frame 35 "failed → filter shortcut": the whole card applies the FAILED filter. */}
          <button
            type="button"
            onClick={applyFailedFilter}
            aria-label={`Failed${stats ? ` ${formatNumber(stats.failed)}` : ''} \u2014 filter the grid to failed jobs`}
            className="focus-visible:ring-ring cursor-pointer rounded-xl text-left outline-none focus-visible:ring-2"
          >
            <StatCard label="Failed" value={stats ? formatNumber(stats.failed) : null} accent="destructive" isLoading={statsLoading} />
          </button>
        </section>
      }
      footer={
        <StatusFooter
          start={<span>{activeQuery.isFetching && !activeQuery.isLoading ? 'Refreshing' : 'Auto-refresh \u00b7 30 s'}</span>}
          end={ENDPOINT_HINT}
        />
      }
    >
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <VirtualizedDataGrid<TranscriptionJob>
          aria-label="Transcription jobs"
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          height={JOBS_GRID_HEIGHT}
          manual={{ filtering: true, pagination: true }}
          rowCount={total}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          persistence={gridPersistence('transcription-jobs')}
          features={{
            columnReorder: true,
            columnResize: true,
            columnPinning: true,
            columnVisibility: true,
            rowSelection: false,
            globalSearch: true,
            facetedFilters: true,
            sorting: false,
          }}
          onRowClick={(row) => setSelectedId(row.id)}
          isLoading={activeQuery.isLoading}
          isBusy={activeQuery.isFetching && !activeQuery.isLoading}
          error={rows.length > 0 ? null : (activeQuery.error ?? null)}
          errorState={(error) => <ErrorState error={error} onRetry={() => void activeQuery.refetch()} />}
          onRetry={() => void activeQuery.refetch()}
          emptyState={empty}
        />
        <JobStreamCard jobId={selectedId} />
      </div>
    </ScreenTemplate>
  );
}
