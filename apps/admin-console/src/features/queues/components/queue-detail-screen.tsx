'use client';

import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
    IconClearAll,
    IconDots,
    IconInbox,
    IconPlayerPause,
    IconPlayerPlay,
    IconPlayerTrackNext,
    IconRefresh,
    IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { parseAsInteger, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { StatCard, type StatCardAccent } from '@arcaai/ui/components/metrics/stat-card';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSelect } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { useTrailingBreadcrumb } from '@/shared/navigation/breadcrumb-store';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useBulkJobAction, useJobs, usePromoteJob, useQueue, useRemoveJob, useRetryJob } from '../api/hooks';
import type { JobStatus, JobSummary } from '../api/types';
import { CleanQueueDialog } from './clean-queue-dialog';
import { JobDetailSheet } from './job-detail-sheet';
import { JobStatusBadge } from './job-status-badge';
import { PauseResumeDialog } from './pause-resume-dialog';
import { toastRequestError } from './toasts';

const JOB_STATUSES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;

const JOB_STATUS_OPTIONS = JOB_STATUSES.map((status) => ({
    value: status,
    label: status.charAt(0).toUpperCase() + status.slice(1),
}));

const stopClick = (event: MouseEvent) => event.stopPropagation();
const stopKey = (event: KeyboardEvent) => event.stopPropagation();

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
        <span className="flex justify-end" onClick={stopClick} onKeyDown={stopKey}>
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

/** Frame 17 — queue detail: header + counters + jobs board with bulk actions. */
export function QueueDetailScreen({ name }: { name: string }) {
    useTrailingBreadcrumb(name);
    const queueQuery = useQueue(name);
    const [params, setParams] = useQueryStates({
        status: parseAsStringLiteral(JOB_STATUSES),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(25),
    });
    const jobsQuery = useJobs(name, { page: params.page, limit: params.limit, status: params.status ?? undefined });

    const retryJob = useRetryJob();
    const promoteJob = usePromoteJob();
    const removeJob = useRemoveJob();
    const bulkJobAction = useBulkJobAction();

    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [queueAction, setQueueAction] = useState<'pause' | 'resume' | 'clean' | null>(null);
    const [removeJobId, setRemoveJobId] = useState<string | null>(null);
    const [bulkAction, setBulkAction] = useState<'retry' | 'remove' | null>(null);
    const [openJobId, setOpenJobId] = useState<string | null>(null);

    const queue = queueQuery.data;
    const items = jobsQuery.data?.items ?? [];
    const total = jobsQuery.data?.total ?? 0;
    const allSelected = items.length > 0 && items.every((job) => selected.has(job.id));
    const someSelected = items.some((job) => selected.has(job.id));

    function toggleJob(jobId: string, checked: boolean) {
        setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(jobId);
            else next.delete(jobId);
            return next;
        });
    }

    function toggleAll(checked: boolean) {
        setSelected((current) => {
            const next = new Set(current);
            for (const job of items) {
                if (checked) next.add(job.id);
                else next.delete(job.id);
            }
            return next;
        });
    }

    function handleRetry(jobId: string) {
        retryJob.mutate(
            { queueName: name, jobId },
            {
                onSuccess: () => toast.success(`Job ${jobId} queued for retry`),
                onError: toastRequestError,
            },
        );
    }

    function handlePromote(jobId: string) {
        promoteJob.mutate(
            { queueName: name, jobId },
            {
                onSuccess: () => toast.success(`Job ${jobId} promoted`),
                onError: toastRequestError,
            },
        );
    }

    function confirmRemove() {
        if (!removeJobId) return;
        const jobId = removeJobId;
        removeJob.mutate(
            { queueName: name, jobId },
            {
                onSuccess: () => {
                    toast.success(`Job ${jobId} removed`);
                    toggleJob(jobId, false);
                    setRemoveJobId(null);
                },
                onError: toastRequestError,
            },
        );
    }

    function runBulk(action: 'retry' | 'remove') {
        bulkJobAction.mutate(
            { queueName: name, body: { action, jobIds: [...selected] } },
            {
                onSuccess: (result) => {
                    toast.success(`Bulk ${action}: ${formatNumber(result.succeeded)} succeeded, ${formatNumber(result.failed)} failed`);
                    setSelected(new Set());
                    setBulkAction(null);
                },
                onError: toastRequestError,
            },
        );
    }

    const columns: DataTableColumn<JobSummary>[] = [
        {
            key: 'select',
            header: (
                <Checkbox
                    aria-label="Select all jobs on page"
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                />
            ),
            headerClassName: 'w-10',
            cell: (row) => (
                <span className="flex" onClick={stopClick} onKeyDown={stopKey}>
                    <Checkbox
                        aria-label={`Select job ${row.id}`}
                        checked={selected.has(row.id)}
                        onCheckedChange={(checked) => toggleJob(row.id, checked === true)}
                    />
                </span>
            ),
        },
        { key: 'id', header: 'Job ID', mono: true, cell: (row) => row.id },
        { key: 'name', header: 'Name', mono: true, cell: (row) => row.name },
        { key: 'state', header: 'State', cell: (row) => <JobStatusBadge status={row.status} /> },
        {
            key: 'attempts',
            header: 'Attempts',
            className: 'tabular-nums',
            cell: (row) => `${formatNumber(row.attempts)}/${formatNumber(row.maxAttempts)}`,
        },
        { key: 'created', header: 'Created', cell: (row) => formatRelativeTime(new Date(row.timestamp)) },
        {
            key: 'finished',
            header: 'Finished',
            cell: (row) => formatRelativeTime(row.finishedOn ? new Date(row.finishedOn) : null),
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            cell: (row) => <JobRowActions job={row} onRetry={handleRetry} onPromote={handlePromote} onRemove={setRemoveJobId} />,
        },
    ];

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

    return (
        <div className="flex flex-col gap-4">
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
            <FilterBar shown={items.length} total={total}>
                <FilterSelect
                    id="jobs-state-filter"
                    label="State"
                    value={params.status ?? ''}
                    onChange={(value) => {
                        setSelected(new Set());
                        void setParams({ status: (value || null) as JobStatus | null, page: null });
                    }}
                    options={JOB_STATUS_OPTIONS}
                />
                {selected.size > 0 ? (
                    <span className="flex items-center gap-2">
                        <span className="text-muted-foreground text-sm tabular-nums">{formatNumber(selected.size)} selected</span>
                        <Button variant="outline" size="sm" onClick={() => setBulkAction('retry')}>
                            <IconRefresh aria-hidden />
                            Retry selected ({formatNumber(selected.size)})
                        </Button>
                        <Button variant="outline" size="sm" className="text-destructive" onClick={() => setBulkAction('remove')}>
                            <IconTrash aria-hidden />
                            Remove selected ({formatNumber(selected.size)})
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                            Clear
                        </Button>
                    </span>
                ) : null}
            </FilterBar>
            <DataTable
                aria-label="Jobs"
                columns={columns}
                rows={items}
                rowKey={(row) => row.id}
                isLoading={jobsQuery.isLoading}
                error={jobsQuery.error ?? undefined}
                onRetry={() => void jobsQuery.refetch()}
                empty={
                    <EmptyState
                        icon={IconInbox}
                        title="No jobs"
                        description={
                            params.status ? `No ${params.status} jobs in this queue right now.` : 'This queue has no jobs right now.'
                        }
                    />
                }
                onRowClick={(row) => setOpenJobId(row.id)}
            />
            <TablePagination
                page={params.page}
                limit={params.limit}
                total={total}
                onPageChange={(page) => {
                    setSelected(new Set());
                    void setParams({ page });
                }}
                onLimitChange={(limit) => {
                    setSelected(new Set());
                    void setParams({ limit, page: null });
                }}
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
                title={`Retry ${formatNumber(selected.size)} selected job${selected.size === 1 ? '' : 's'}?`}
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
                title={`Remove ${formatNumber(selected.size)} selected job${selected.size === 1 ? '' : 's'}?`}
                description="The selected jobs are permanently deleted from the queue. This cannot be undone."
                confirmLabel="Remove jobs"
                destructive
                isPending={bulkJobAction.isPending}
                onConfirm={() => runBulk('remove')}
            />
        </div>
    );
}
