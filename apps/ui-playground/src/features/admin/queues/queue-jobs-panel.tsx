import { useMemo, useState } from 'react';
import type { ColumnDef, PaginationState, RowSelectionState } from '@tanstack/react-table';
import { toast } from 'sonner';
import { AdminDataTable, ConfirmDialog } from '../components';
import {
  useBulkJobAction,
  useQueueJob,
  useQueueJobs,
  usePromoteJob,
  useRemoveJob,
  useRetryJob,
  JOB_STATUS_FILTERS,
  type JobStatusFilter,
  type JobSummary,
} from './api/queues';
import { InlineError, JobStatusBadge, errorMessage, formatTimestamp, shortId } from './utils';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@arcaai/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { ArrowUpToLine, RotateCw, Search, Trash2 } from 'lucide-react';

const ALL = 'all';

interface RemoveTarget {
  jobId: string;
}

export function QueueJobsPanel({ queueName }: { queueName: string }) {
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });
  const [status, setStatus] = useState<JobStatusFilter | ''>('');
  const [nameInput, setNameInput] = useState('');
  const [appliedName, setAppliedName] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedJobId, setSelectedJobId] = useState('');
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [bulkRemove, setBulkRemove] = useState(false);

  const query = useQueueJobs(queueName, {
    page: pagination.pageIndex,
    limit: pagination.pageSize,
    status: status || undefined,
    jobName: appliedName || undefined,
  });

  const retry = useRetryJob();
  const promote = usePromoteJob();
  const remove = useRemoveJob();
  const bulk = useBulkJobAction();

  const jobs = useMemo(() => query.data?.items ?? [], [query.data]);

  const selectedJobIds = useMemo(
    () =>
      Object.keys(rowSelection)
        .filter((k) => rowSelection[k])
        .map((idx) => jobs[Number(idx)]?.id)
        .filter((id): id is string => Boolean(id)),
    [rowSelection, jobs],
  );

  const resetSelection = () => setRowSelection({});

  const onPaginationChange: typeof setPagination = (updater) => {
    resetSelection();
    setPagination(updater);
  };

  const applyName = () => {
    setAppliedName(nameInput.trim());
    resetSelection();
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  };

  const onStatusChange = (value: string) => {
    setStatus(value === ALL ? '' : (value as JobStatusFilter));
    resetSelection();
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  };

  const runRowAction = (label: string, fn: () => Promise<unknown>) => {
    void fn()
      .then(() => toast.success(label))
      .catch((e) => toast.error(errorMessage(e)));
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    const { jobId } = removeTarget;
    remove.mutate(
      { queueName, jobId },
      {
        onSuccess: () => toast.success(`Removed job ${shortId(jobId)}`),
        onError: (e) => toast.error(errorMessage(e)),
        onSettled: () => setRemoveTarget(null),
      },
    );
  };

  const runBulk = (action: 'retry' | 'remove') => {
    if (selectedJobIds.length === 0) return;
    bulk.mutate(
      { queueName, action, jobIds: selectedJobIds },
      {
        onSuccess: (res) => {
          toast.success(`${action === 'retry' ? 'Retried' : 'Removed'} ${res.succeeded} job(s)${res.failed ? `, ${res.failed} failed` : ''}`);
          resetSelection();
        },
        onError: (e) => toast.error(errorMessage(e)),
        onSettled: () => setBulkRemove(false),
      },
    );
  };

  const columns = useMemo<ColumnDef<JobSummary, unknown>[]>(
    () => [
      { id: 'id', header: 'Job ID', cell: ({ row }) => <span className="font-mono text-xs">{shortId(row.original.id)}</span> },
      { id: 'name', header: 'Name', cell: ({ row }) => <span className="text-sm">{row.original.name}</span> },
      { id: 'status', header: 'Status', cell: ({ row }) => <JobStatusBadge status={row.original.status} /> },
      {
        id: 'attempts',
        header: 'Attempts',
        cell: ({ row }) => <span className="tabular-nums">{`${row.original.attempts}/${row.original.maxAttempts}`}</span>,
      },
      {
        id: 'progress',
        header: 'Progress',
        cell: ({ row }) => <span className="tabular-nums">{row.original.progress != null ? `${row.original.progress}%` : '—'}</span>,
      },
      {
        id: 'timestamp',
        header: 'Created',
        cell: ({ row }) => <span className="text-muted-foreground text-xs">{formatTimestamp(row.original.timestamp)}</span>,
      },
      {
        id: 'actions',
        header: '',
        size: 132,
        cell: ({ row }) => {
          const job = row.original;
          return (
            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              {job.status === 'failed' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  title="Retry"
                  onClick={() => runRowAction(`Retried job ${shortId(job.id)}`, () => retry.mutateAsync({ queueName, jobId: job.id }))}
                >
                  <RotateCw className="size-3.5" />
                </Button>
              )}
              {job.status === 'delayed' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  title="Promote"
                  onClick={() => runRowAction(`Promoted job ${shortId(job.id)}`, () => promote.mutateAsync({ queueName, jobId: job.id }))}
                >
                  <ArrowUpToLine className="size-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive size-7"
                title="Remove"
                onClick={() => setRemoveTarget({ jobId: job.id })}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          );
        },
      },
    ],
    [queueName],
  );

  return (
    <div className="flex flex-col gap-3">
      {query.isError && <InlineError error={query.error} />}

      <AdminDataTable
        data={jobs}
        columns={columns}
        pagination={pagination}
        onPaginationChange={onPaginationChange}
        rowCount={query.data?.total ?? 0}
        enableRowSelection
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        isLoading={query.isLoading || query.isFetching}
        emptyMessage="No jobs match this filter."
        onRowClick={(job) => setSelectedJobId(job.id)}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={status || ALL} onValueChange={onStatusChange}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {JOB_STATUS_FILTERS.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <Input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyName()}
                placeholder="Filter by job name"
                className="h-9 w-56"
              />
              <Button variant="outline" size="icon" className="size-9" onClick={applyName} title="Apply name filter">
                <Search className="size-4" />
              </Button>
            </div>
            {selectedJobIds.length > 0 && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-muted-foreground text-sm">{selectedJobIds.length} selected</span>
                <Button variant="outline" size="sm" disabled={bulk.isPending} onClick={() => runBulk('retry')}>
                  <RotateCw className="mr-1.5 size-3.5" />
                  Retry
                </Button>
                <Button variant="outline" size="sm" className="text-destructive" disabled={bulk.isPending} onClick={() => setBulkRemove(true)}>
                  <Trash2 className="mr-1.5 size-3.5" />
                  Remove
                </Button>
              </div>
            )}
          </div>
        }
      />

      {/* Single job detail (PII-redacted) */}
      <JobDetailSheet queueName={queueName} jobId={selectedJobId} onClose={() => setSelectedJobId('')} />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title="Remove job?"
        description={`Permanently remove job ${removeTarget ? shortId(removeTarget.jobId) : ''} from the "${queueName}" queue. This cannot be undone.`}
        confirmLabel="Remove"
        variant="destructive"
        isLoading={remove.isPending}
        onConfirm={confirmRemove}
      />

      <ConfirmDialog
        open={bulkRemove}
        onOpenChange={setBulkRemove}
        title="Remove selected jobs?"
        description={`Permanently remove ${selectedJobIds.length} selected job(s) from the "${queueName}" queue. This cannot be undone.`}
        confirmLabel="Remove all"
        variant="destructive"
        isLoading={bulk.isPending}
        onConfirm={() => runBulk('remove')}
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="col-span-2 wrap-break-word">{value}</span>
    </div>
  );
}

function JobDetailSheet({ queueName, jobId, onClose }: { queueName: string; jobId: string; onClose: () => void }) {
  const { data: job, isLoading, isError, error } = useQueueJob(queueName, jobId);

  return (
    <Sheet open={!!jobId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Job detail</SheetTitle>
          <SheetDescription>
            Job <span className="font-mono">{shortId(jobId)}</span> in <span className="font-medium">{queueName}</span>. Payload is PII-redacted.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6">
          {isLoading ? (
            <p className="text-muted-foreground py-8 text-center text-sm">Loading…</p>
          ) : isError ? (
            <InlineError error={error} />
          ) : job ? (
            <div className="flex flex-col gap-4">
              <div>
                <DetailRow label="ID" value={<span className="font-mono text-xs">{job.id}</span>} />
                <DetailRow label="Name" value={job.name} />
                <DetailRow label="Status" value={<JobStatusBadge status={job.status} />} />
                <DetailRow label="Attempts" value={`${job.attempts}/${job.maxAttempts}`} />
                <DetailRow label="Progress" value={job.progress != null ? `${job.progress}%` : '—'} />
                <DetailRow label="Created" value={formatTimestamp(job.timestamp)} />
                <DetailRow label="Processed" value={formatTimestamp(job.processedOn)} />
                <DetailRow label="Finished" value={formatTimestamp(job.finishedOn)} />
                {job.failedReason && <DetailRow label="Failed reason" value={<span className="text-destructive">{job.failedReason}</span>} />}
              </div>

              <div>
                <p className="mb-1 text-sm font-medium">Data (redacted)</p>
                <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs">{JSON.stringify(job.data, null, 2)}</pre>
              </div>

              {job.stacktrace.length > 0 && (
                <div>
                  <p className="mb-1 text-sm font-medium">Stacktrace</p>
                  <pre className="bg-muted text-destructive max-h-64 overflow-auto rounded-md p-3 text-xs">{job.stacktrace.join('\n')}</pre>
                </div>
              )}

              {job.logs.length > 0 && (
                <div>
                  <p className="mb-1 text-sm font-medium">Logs</p>
                  <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 text-xs">{job.logs.join('\n')}</pre>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
