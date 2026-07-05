'use client';

import { useState } from 'react';
import { IconFilterOff, IconInbox, IconRefresh } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { useQueryClient } from '@tanstack/react-query';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { transcriptionJobKeys, useTranscriptionJobStats, useTranscriptionJobs, useTranscriptionJobsByStatus } from '../api';
import type { TranscriptionJob, TranscriptionJobStats, TranscriptionJobStatus } from '../api';
import { JOB_STATUS_META, TranscriptionJobStatusBadge } from './job-status-badge';
import { JobStreamCard } from './job-stream-panel';

const JOB_STATUSES = ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'] as const;

const STATUS_OPTIONS: FilterOption[] = JOB_STATUSES.map((status) => ({ value: status, label: JOB_STATUS_META[status].label }));

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
    const [{ search, status, page, limit }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        status: parseAsStringLiteral(JOB_STATUSES),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(25),
    });
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const statsQuery = useTranscriptionJobStats();
    // The gateway list is 1-based; the URL keeps the 0-based house convention.
    const listQuery = useTranscriptionJobs({ page: page + 1, limit }, status === null);
    const statusQuery = useTranscriptionJobsByStatus(status);

    const activeQuery = status !== null ? statusQuery : listQuery;
    const loaded: TranscriptionJob[] = status !== null ? (statusQuery.data ?? []) : (listQuery.data?.data ?? []);
    const rows = search ? loaded.filter((job) => job.id.toLowerCase().includes(search.toLowerCase())) : loaded;
    const total = status !== null ? loaded.length : (listQuery.data?.total ?? 0);
    const hasFilters = Boolean(search || status);

    const stats = statsQuery.data;
    const statsLoading = statsQuery.isPending || (statsQuery.isError && statsQuery.isFetching);

    function applyFailedFilter() {
        setSelectedId(null);
        void setParams({ status: 'FAILED', page: null });
    }

    function handleRefresh() {
        void queryClient.invalidateQueries({ queryKey: transcriptionJobKeys.root });
    }

    const columns: DataTableColumn<TranscriptionJob>[] = [
        {
            key: 'id',
            header: 'Job',
            mono: true,
            cell: (row) => (
                <span className={`block max-w-48 truncate ${row.id === selectedId ? 'text-primary font-semibold' : ''}`} title={row.id}>
                    {row.id}
                </span>
            ),
        },
        { key: 'status', header: 'Status', cell: (row) => <TranscriptionJobStatusBadge status={row.status} /> },
        { key: 'duration', header: 'Dur.', className: 'tabular-nums', cell: (row) => formatJobDuration(row) },
        {
            key: 'updated',
            header: 'Updated',
            cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.updatedAt)}</span>,
        },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No jobs in range"
            description="Filter mismatch — try a different search or clear the filters."
            action={
                <Button variant="outline" onClick={() => void setParams({ search: null, status: null, page: null })}>
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
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Transcription Jobs"
                meta={
                    <>
                        {stats ? <span>{formatNumber(statsTotal(stats))} jobs</span> : <Skeleton className="h-4 w-16" />}
                        {ENDPOINT_HINT}
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
            <FilterBar shown={rows.length} total={total}>
                <FilterSearch
                    label="Search job id"
                    placeholder={'Search job id\u2026'}
                    value={search}
                    onChange={(value) => void setParams({ search: value || null })}
                />
                <FilterSelect
                    id="jobs-status-filter"
                    label="Status"
                    value={status ?? ''}
                    onChange={(value) => {
                        setSelectedId(null);
                        void setParams({ status: (value || null) as TranscriptionJobStatus | null, page: null });
                    }}
                    options={STATUS_OPTIONS}
                />
                <span aria-hidden className="text-muted-foreground hidden font-mono text-xs lg:inline">
                    GET status/:status
                </span>
            </FilterBar>
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                <div className="flex flex-col gap-3">
                    <DataTable
                        aria-label="Transcription jobs"
                        columns={columns}
                        rows={rows}
                        rowKey={(row) => row.id}
                        isLoading={activeQuery.isLoading}
                        error={activeQuery.error ?? undefined}
                        onRetry={() => void activeQuery.refetch()}
                        empty={empty}
                        onRowClick={(row) => setSelectedId(row.id)}
                    />
                    {status === null ? (
                        <TablePagination
                            page={page}
                            limit={limit}
                            total={total}
                            onPageChange={(next) => void setParams({ page: next || null })}
                            onLimitChange={(next) => void setParams({ limit: next, page: null })}
                        />
                    ) : null}
                </div>
                <JobStreamCard jobId={selectedId} />
            </div>
        </div>
    );
}
