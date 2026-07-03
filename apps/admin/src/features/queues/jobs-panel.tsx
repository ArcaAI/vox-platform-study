import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Checkbox } from '@arcaai/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@arcaai/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { StatusBadge } from '@arcaai/ui/components/shared';
import type { JobDetail, JobStatusFilter, JobSummary, PaginatedJobs } from '@arcaai/vox';
import { AlertTriangle, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MOBILE_DIALOG_CONTENT } from '@/lib/responsive';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

const STATUS_FILTERS: Array<{ value: JobStatusFilter | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'delayed', label: 'Delayed' },
];

function jobStatusRole(status: string): 'success' | 'warning' | 'destructive' | 'info' | 'neutral' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'active':
      return 'info';
    case 'delayed':
      return 'warning';
    default:
      return 'neutral';
  }
}

function formatEpoch(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

/** Job-detail dialog: PII-redacted payload, options, stacktrace `pre` (design §5.4 job-detail state). */
function JobDetailDialog({ detail, open, onOpenChange }: { detail: JobDetail | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-2xl', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{detail?.id ?? 'Job'}</span>
            {detail ? <StatusBadge label={detail.status} colorRole={jobStatusRole(detail.status)} /> : null}
          </DialogTitle>
          <DialogDescription>
            {detail?.name} · attempts{' '}
            <span className="tabular-nums">
              {detail?.attempts ?? 0}/{detail?.maxAttempts ?? 0}
            </span>{' '}
            · processed {formatEpoch(detail?.processedOn ?? null)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {detail?.failedReason ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Failed reason</AlertTitle>
              <AlertDescription className="break-words">{detail.failedReason}</AlertDescription>
            </Alert>
          ) : null}
          <div>
            <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Payload (PII-redacted)</h4>
            <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">{JSON.stringify(detail?.data ?? {}, null, 2)}</pre>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Options</h4>
            <pre className="max-h-32 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">{JSON.stringify(detail?.opts ?? {}, null, 2)}</pre>
          </div>
          {detail?.stacktrace?.length ? (
            <div>
              <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Stacktrace</h4>
              <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">{detail.stacktrace.join('\n\n')}</pre>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * TASK-403 — per-queue jobs drawer (design §5.4: "selected queue reveals a jobs
 * sub-panel/drawer … full-screen sheet on mobile"). Status filter + pagination
 * + job detail + retry (single/bulk). Retry is the ONLY mutation — remove /
 * promote are intentionally not offered (non-destructive constraint; the SDK
 * exposes no such methods).
 */
export function JobsPanel({
  queueName,
  initialStatus,
  open,
  onOpenChange,
  listJobs,
  getJob,
  retryJob,
  bulkRetry,
  onMutated,
}: {
  queueName: string | null;
  initialStatus: JobStatusFilter | 'all';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listJobs: (queueName: string, params?: { page?: number; limit?: number; status?: JobStatusFilter }) => Promise<PaginatedJobs>;
  getJob: (queueName: string, jobId: string) => Promise<JobDetail>;
  retryJob: (queueName: string, jobId: string) => Promise<void>;
  bulkRetry: (queueName: string, jobIds: string[]) => Promise<{ succeeded: number; failed: number }>;
  /** Parent refreshes queue counts after a retry mutates queue state. */
  onMutated: () => void;
}) {
  const [status, setStatus] = useState<JobStatusFilter | 'all'>(initialStatus);
  const [page, setPage] = useState(0);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-arm the filter when the panel opens for a (possibly different) queue.
  useEffect(() => {
    if (open) {
      setStatus(initialStatus);
      setPage(0);
      setSelected(new Set());
    }
  }, [open, queueName, initialStatus]);

  const load = useCallback(async () => {
    if (!queueName) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await listJobs(queueName, { page, limit: PAGE_SIZE, status: status === 'all' ? undefined : status });
      setJobs(result.items);
      setTotal(result.total);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }, [queueName, page, status, listJobs]);

  useEffect(() => {
    if (open && queueName) void load();
  }, [open, queueName, load]);

  const failedSelectable = useMemo(() => jobs.filter((j) => j.status === 'failed'), [jobs]);
  const allFailedSelected = failedSelectable.length > 0 && failedSelectable.every((j) => selected.has(j.id));
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggle = (jobId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const toggleAllFailed = () => {
    setSelected(allFailedSelected ? new Set() : new Set(failedSelectable.map((j) => j.id)));
  };

  const onRetryOne = async (job: JobSummary) => {
    if (!queueName) return;
    setBusy(true);
    try {
      await retryJob(queueName, job.id);
      toast.success(`Retried job ${job.id}`);
      await load();
      onMutated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  const onBulkRetry = async () => {
    if (!queueName || selected.size === 0) return;
    setBusy(true);
    try {
      const result = await bulkRetry(queueName, Array.from(selected));
      toast.success(`Bulk retry: ${result.succeeded} succeeded, ${result.failed} failed`);
      setSelected(new Set());
      await load();
      onMutated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk retry failed');
    } finally {
      setBusy(false);
    }
  };

  const onViewDetail = async (job: JobSummary) => {
    if (!queueName) return;
    try {
      setDetail(await getJob(queueName, job.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load job detail');
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Full-screen on mobile per the design's responsive rule. */}
      <SheetContent side="right" className="flex w-full flex-col gap-0 max-sm:max-w-none sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>
            Jobs · <span className="font-mono">{queueName}</span>
          </SheetTitle>
          <SheetDescription>
            Payloads are PII-redacted. Retry is the only action — destructive job operations are disabled in this console.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as JobStatusFilter | 'all');
                setPage(0);
                setSelected(new Set());
              }}
            >
              <SelectTrigger className="w-44" aria-label="Filter jobs by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected.size > 0 ? (
              <Button size="sm" onClick={() => void onBulkRetry()} disabled={busy}>
                <RotateCcw className="size-4" />
                Retry {selected.size} selected
              </Button>
            ) : null}
          </div>

          {loadError ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Couldn’t load jobs</AlertTitle>
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={allFailedSelected}
                      onCheckedChange={toggleAllFailed}
                      disabled={failedSelectable.length === 0}
                      aria-label="Select all failed jobs on this page"
                    />
                  </TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && jobs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : jobs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      No jobs{status !== 'all' ? ` with status “${status}”` : ''}.
                    </TableCell>
                  </TableRow>
                ) : (
                  jobs.map((job) => (
                    <TableRow key={job.id} data-testid={`job-row-${job.id}`}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(job.id)}
                          onCheckedChange={() => toggle(job.id)}
                          disabled={job.status !== 'failed'}
                          aria-label={`Select job ${job.id} for bulk retry`}
                        />
                      </TableCell>
                      <TableCell>
                        <button type="button" className="text-left" onClick={() => void onViewDetail(job)}>
                          <div className="font-mono text-xs">{job.id}</div>
                          <div className="text-xs text-muted-foreground">{job.name}</div>
                          {job.failedReason ? <div className="max-w-64 truncate text-xs text-destructive">{job.failedReason}</div> : null}
                        </button>
                      </TableCell>
                      <TableCell>
                        <StatusBadge label={job.status} colorRole={jobStatusRole(job.status)} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {job.attempts}/{job.maxAttempts}
                      </TableCell>
                      <TableCell className="text-right">
                        {job.status === 'failed' ? (
                          <Button variant="ghost" size="sm" onClick={() => void onRetryOne(job)} disabled={busy} aria-label={`Retry job ${job.id}`}>
                            <RotateCcw className="size-4" />
                            Retry
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="tabular-nums">
              {total} job{total === 1 ? '' : 's'} · page {page + 1}/{pageCount}
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => setPage((p) => p + 1)}
                disabled={page + 1 >= pageCount}
                aria-label="Next page"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        <JobDetailDialog detail={detail} open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} />
      </SheetContent>
    </Sheet>
  );
}
