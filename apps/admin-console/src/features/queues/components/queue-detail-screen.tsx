'use client';

import { useCallback, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
    IconClearAll,
    IconDots,
    IconFilterOff,
    IconInbox,
    IconPlayerPause,
    IconPlayerPlay,
    IconPlayerTrackNext,
    IconRefresh,
    IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef, type DataQueryState, type RowSelectionState } from '@arcaai/ui';
import { StatCard, type StatCardAccent } from '@arcaai/ui/components/metrics/stat-card';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { useTrailingBreadcrumb } from '@/shared/navigation/breadcrumb-store';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useBulkJobAction, useJobs, usePromoteJob, useQueue, useRemoveJob, useRetryJob } from '../api/hooks';
import type { JobStatus, JobSummary, ListJobsParams } from '../api/types';
import { CleanQueueDialog } from './clean-queue-dialog';
import { JobDetailSheet } from './job-detail-sheet';
import { JobStatusBadge } from './job-status-badge';
import { PauseResumeDialog } from './pause-resume-dialog';
import { toastRequestError } from './toasts';

const JOB_STATUSES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;

const JOB_STATUS_OPTIONS: FilterOption[] = JOB_STATUSES.map((status) => ({
    value: status,
    label: status.charAt(0).toUpperCase() + status.slice(1),
}));

const stopClick = (event: MouseEvent) => event.stopPropagation();
const stopKey = (event: KeyboardEvent) => event.stopPropagation();

/** Reads the single-value `status` facet off the grid state (the only server-supported job filter). */
function jobStatusFromState(state: DataQueryState): JobStatus | undefined {
    const rule = state.filters.find((entry) => entry.id === 'status');
    const value = Array.isArray(rule?.value) ? rule?.value[0] : rule?.value;
    return typeof value === 'string' && value ? (value as JobStatus) : undefined;
}

function JobRowActions({
    job,
    onRetry,
    onPromote,
    onRemove,
}: {
    job: JobSummary;
    onRetry: (jobId: string) => void;
    onPromote: (jobId: string) => void;
    onRemove: (jobId: string) => void;
}) {
    const status = job.status.toLowerCase();
    return (
        <span className="flex w-full justify-end" onClick={stopClick} onKeyDown={stopKey}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for job ${job.id}`}>
                        <IconDots aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {status === 'failed' ? (
                        <DropdownMenuItem onSelect={() => onRetry(job.id)}>
                            <IconRefresh aria-hidden />
                            Retry
                        </DropdownMenuItem>
                    ) : null}
                    {status === 'delayed' ? (
                        <DropdownMenuItem onSelect={() => onPromote(job.id)}>
                            <IconPlayerTrackNext aria-hidden />
                            Promote
                        </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem variant="destructive" onSelect={() => onRemove(job.id)}>
                        <IconTrash aria-hidden />
                        Remove
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}

/** Frame 17 — queue detail: header + counters + jobs board (AdminDataGrid) with bulk actions. */
export function QueueDetailScreen({ name }: { name: string }) {
    useTrailingBreadcrumb(name);
    const queueQuery = useQueue(name);

    // The jobs endpoint (ListJobsQuery) whitelists only page/limit/status/jobName —
    // it rejects the generic search/filters/sort. So the grid owns the shareable
    // URL state, and we map it onto those discrete knobs: the State facet → `status`,
    // the omni search → `jobName`.
    const query = useAdminGridParams();
    const [selected, setSelected] = useState<RowSelectionState>({});
    const [queueAction, setQueueAction] = useState<'pause' | 'resume' | 'clean' | null>(null);
    const [removeJobId, setRemoveJobId] = useState<string | null>(null);
    const [bulkAction, setBulkAction] = useState<'retry' | 'remove' | null>(null);
    const [openJobId, setOpenJobId] = useState<string | null>(null);

    const jobsParams = useMemo<ListJobsParams>(() => {
        const state = query.queryState;
        const page = state.pagination.mode === 'offset' ? state.pagination.page : 0;
        const status = jobStatusFromState(state);
        const jobName = state.globalSearch?.trim();
        return { page, limit: state.pagination.limit, ...(status ? { status } : {}), ...(jobName ? { jobName } : {}) };
    }, [query.queryState]);

    // A result-set change (state facet / job-name search / page) drops the current
    // page's selection — parity with the legacy screen.
    const onQueryStateChange = useCallback(
        (next: DataQueryState) => {
            setSelected({});
            query.setQueryState(next);
        },
        [query],
    );

    const clearFilters = useCallback(
        () => onQueryStateChange({ ...query.queryState, globalSearch: undefined, filters: [] }),
        [onQueryStateChange, query.queryState],
    );

    const jobsQuery = useJobs(name, jobsParams);
    const { rows: items, total } = normalizeList<JobSummary>(jobsQuery.data);
    const totalCount = total ?? 0;

    const { mutate: mutateRetry } = useRetryJob();
    const { mutate: mutatePromote } = usePromoteJob();
    const removeJob = useRemoveJob();
    const bulkJobAction = useBulkJobAction();

    const selectedIds = useMemo(() => Object.keys(selected).filter((id) => selected[id]), [selected]);

    const queue = queueQuery.data;

    const handleRetry = useCallback(
        (jobId: string) => {
            mutateRetry(
                { queueName: name, jobId },
                { onSuccess: () => toast.success(`Job ${jobId} queued for retry`), onError: toastRequestError },
            );
        },
        [mutateRetry, name],
    );

    const handlePromote = useCallback(
        (jobId: string) => {
            mutatePromote(
                { queueName: name, jobId },
                { onSuccess: () => toast.success(`Job ${jobId} promoted`), onError: toastRequestError },
            );
        },
        [mutatePromote, name],
    );

    function confirmRemove() {
        if (!removeJobId) return;
        const jobId = removeJobId;
        removeJob.mutate(
            { queueName: name, jobId },
            {
                onSuccess: () => {
                    toast.success(`Job ${jobId} removed`);
                    setSelected((current) => {
                        const next = { ...current };
                        delete next[jobId];
                        return next;
                    });
                    setRemoveJobId(null);
                },
                onError: toastRequestError,
            },
        );
    }

    function runBulk(action: 'retry' | 'remove') {
        bulkJobAction.mutate(
            { queueName: name, body: { action, jobIds: selectedIds } },
            {
                onSuccess: (result) => {
                    toast.success(`Bulk ${action}: ${formatNumber(result.succeeded)} succeeded, ${formatNumber(result.failed)} failed`);
                    setSelected({});
                    setBulkAction(null);
                },
                onError: toastRequestError,
            },
        );
    }

    const columns = useMemo<ColumnDef<JobSummary>[]>(
        () => [
            {
                accessorKey: 'id',
                header: 'Job ID',
                enableSorting: false,
                meta: { label: 'Job ID' },
                cell: ({ row }) => <span className="font-mono text-xs">{row.original.id}</span>,
                size: 160,
                minSize: 120,
            },
            {
                accessorKey: 'name',
                header: 'Name',
                enableSorting: false,
                meta: { label: 'Name' },
                cell: ({ row }) => <span className="font-mono text-xs">{row.original.name}</span>,
                size: 200,
            },
            {
                accessorKey: 'status',
                header: 'State',
                enableSorting: false,
                meta: { label: 'State', variant: 'select', options: JOB_STATUS_OPTIONS },
                cell: ({ row }) => <JobStatusBadge status={row.original.status} />,
                size: 130,
            },
            {
                id: 'attempts',
                header: 'Attempts',
                enableSorting: false,
                meta: { label: 'Attempts' },
                cell: ({ row }) => (
                    <span className="tabular-nums">
                        {formatNumber(row.original.attempts)}/{formatNumber(row.original.maxAttempts)}
                    </span>
                ),
                size: 110,
            },
            {
                id: 'created',
                header: 'Created',
                enableSorting: false,
                meta: { label: 'Created' },
                cell: ({ row }) => formatRelativeTime(new Date(row.original.timestamp)),
                size: 140,
            },
            {
                id: 'finished',
                header: 'Finished',
                enableSorting: false,
                meta: { label: 'Finished' },
                cell: ({ row }) => formatRelativeTime(row.original.finishedOn ? new Date(row.original.finishedOn) : null),
                size: 140,
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
                cell: ({ row }) => <JobRowActions job={row.original} onRetry={handleRetry} onPromote={handlePromote} onRemove={setRemoveJobId} />,
            },
        ],
        [handleRetry, handlePromote],
    );

    if (queueQuery.error && !queue) {
        return (
            <div className="flex flex-col gap-4">
                <PageHeader title={name} />
                <ErrorState error={queueQuery.error} onRetry={() => void queueQuery.refetch()} />
            </div>
        );
    }

    const counters: { label: string; value: number | undefined; accent: StatCardAccent }[] = [
        { label: 'Waiting', value: queue?.counts.waiting, accent: 'default' },
        { label: 'Active', value: queue?.counts.active, accent: 'primary' },
        { label: 'Delayed', value: queue?.counts.delayed, accent: 'warning' },
        { label: 'Failed', value: queue?.counts.failed, accent: 'destructive' },
        { label: 'Completed', value: queue?.counts.completed, accent: 'success' },
        { label: 'Workers', value: queue?.workerCount, accent: 'default' },
    ];

    const actionBar = (
        <div role="toolbar" aria-label="Bulk job actions" className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-2">
            <span className="px-1 text-sm font-medium" aria-live="polite">
                {formatNumber(selectedIds.length)} selected
            </span>
            <Button variant="outline" size="sm" onClick={() => setBulkAction('retry')}>
                <IconRefresh aria-hidden />
                Retry selected ({formatNumber(selectedIds.length)})
            </Button>
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setBulkAction('remove')}>
                <IconTrash aria-hidden />
                Remove selected ({formatNumber(selectedIds.length)})
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected({})}>
                Clear
            </Button>
        </div>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            <PageHeader
                title={<span className="font-mono">{name}</span>}
                meta={
                    queue ? (
                        <>
                            <StatusDot colorRole={queue.isPaused ? 'warning' : 'success'} label={queue.isPaused ? 'Paused' : 'Running'} />
                            <span aria-hidden>&middot;</span>
                            <span>{formatNumber(queue.workerCount)} workers</span>
                            <span aria-hidden>&middot;</span>
                            <span className="font-mono text-xs">GET /admin/queues/{name}</span>
                        </>
                    ) : (
                        <Skeleton className="h-4 w-64" />
                    )
                }
                actions={
                    queue ? (
                        <>
                            {queue.isPaused ? (
                                <Button variant="outline" onClick={() => setQueueAction('resume')}>
                                    <IconPlayerPlay aria-hidden />
                                    Resume
                                </Button>
                            ) : (
                                <Button variant="outline" onClick={() => setQueueAction('pause')}>
                                    <IconPlayerPause aria-hidden />
                                    Pause
                                </Button>
                            )}
                            <Button variant="destructive" onClick={() => setQueueAction('clean')}>
                                <IconClearAll aria-hidden />
                                Clean jobs
                            </Button>
                        </>
                    ) : undefined
                }
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {counters.map((counter) => (
                    <StatCard
                        key={counter.label}
                        label={counter.label}
                        value={queue ? formatNumber(counter.value) : ''}
                        accent={counter.accent}
                        isLoading={queueQuery.isLoading}
                    />
                ))}
            </div>
            <AdminDataGrid<JobSummary>
                gridId="queue-jobs"
                aria-label="Jobs"
                columns={columns}
                rows={items}
                total={totalCount}
                queryState={query.queryState}
                onQueryStateChange={onQueryStateChange}
                isLoading={jobsQuery.isLoading}
                isBusy={jobsQuery.isFetching && !jobsQuery.isLoading}
                error={jobsQuery.error ?? undefined}
                onRetry={() => void jobsQuery.refetch()}
                onRowClick={(row) => setOpenJobId(row.id)}
                selection={{ value: selected, onChange: setSelected }}
                actionBar={actionBar}
                emptyState={<EmptyState icon={IconInbox} title="No jobs" description="This queue has no jobs right now." />}
                emptyFilteredState={
                    <EmptyState
                        icon={IconFilterOff}
                        title="No jobs match the filters"
                        description="No jobs match the current state or search — clear the filters to see the full queue."
                        action={
                            <Button variant="outline" onClick={clearFilters}>
                                <IconFilterOff aria-hidden />
                                Clear filters
                            </Button>
                        }
                    />
                }
            />
            <JobDetailSheet
                queueName={name}
                jobId={openJobId}
                onOpenChange={(open) => {
                    if (!open) setOpenJobId(null);
                }}
            />
            <PauseResumeDialog
                queueName={name}
                action={queueAction === 'resume' ? 'resume' : 'pause'}
                open={queueAction === 'pause' || queueAction === 'resume'}
                onOpenChange={(open) => {
                    if (!open) setQueueAction(null);
                }}
            />
            <CleanQueueDialog
                queueName={name}
                open={queueAction === 'clean'}
                onOpenChange={(open) => {
                    if (!open) setQueueAction(null);
                }}
            />
            <ConfirmDialog
                open={removeJobId !== null}
                onOpenChange={(open) => {
                    if (!open) setRemoveJobId(null);
                }}
                title={`Remove job ${removeJobId ?? ''}?`}
                description="The job and its data are permanently deleted from the queue. This cannot be undone."
                confirmLabel="Remove job"
                destructive
                isPending={removeJob.isPending}
                onConfirm={confirmRemove}
            />
            <ConfirmDialog
                open={bulkAction === 'retry'}
                onOpenChange={(open) => {
                    if (!open) setBulkAction(null);
                }}
                title={`Retry ${formatNumber(selectedIds.length)} selected job${selectedIds.length === 1 ? '' : 's'}?`}
                description="The selected jobs are re-queued for processing."
                confirmLabel="Retry jobs"
                isPending={bulkJobAction.isPending}
                onConfirm={() => runBulk('retry')}
            />
            <ConfirmDialog
                open={bulkAction === 'remove'}
                onOpenChange={(open) => {
                    if (!open) setBulkAction(null);
                }}
                title={`Remove ${formatNumber(selectedIds.length)} selected job${selectedIds.length === 1 ? '' : 's'}?`}
                description="The selected jobs are permanently deleted from the queue. This cannot be undone."
                confirmLabel="Remove jobs"
                destructive
                isPending={bulkJobAction.isPending}
                onConfirm={() => runBulk('remove')}
            />
        </div>
    );
}
