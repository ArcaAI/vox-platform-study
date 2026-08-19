'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatNumber, formatPercent } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useJob } from '../api/hooks';
import type { JobDetail } from '../api/types';
import { JobStatusBadge } from './job-status-badge';

const PRE_CLASS = 'bg-muted max-h-72 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap';

function JsonSection({ title, value }: { title: string; value: unknown }) {
  const json = JSON.stringify(value, null, 4) ?? 'null';
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <CopyButton value={json} label={`Copy ${title.toLowerCase()}`} />
      </div>
      <pre className={PRE_CLASS}>{json}</pre>
    </section>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function JobDetailBody({ job }: { job: JobDetail }) {
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <MetaItem label="Name">
          <span className="font-mono text-xs">{job.name}</span>
        </MetaItem>
        <MetaItem label="State">
          <JobStatusBadge status={job.status} />
        </MetaItem>
        <MetaItem label="Attempts">
          <span className="tabular-nums">
            {formatNumber(job.attempts)}/{formatNumber(job.maxAttempts)}
          </span>
        </MetaItem>
        <MetaItem label="Progress">{job.progress === null ? '\u2014' : formatPercent(job.progress)}</MetaItem>
        <MetaItem label="Created">{formatDateTime(new Date(job.timestamp))}</MetaItem>
        <MetaItem label="Processed">{formatDateTime(job.processedOn ? new Date(job.processedOn) : null)}</MetaItem>
        <MetaItem label="Finished">{formatDateTime(job.finishedOn ? new Date(job.finishedOn) : null)}</MetaItem>
        <MetaItem label="Priority">
          <span className="tabular-nums">{formatNumber(job.opts.priority)}</span>
        </MetaItem>
      </dl>
      {job.failedReason ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden />
          <AlertTitle>Failed reason</AlertTitle>
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{job.failedReason}</AlertDescription>
        </Alert>
      ) : null}
      <JsonSection title="Payload" value={job.data} />
      {job.returnValue !== null && job.returnValue !== undefined ? <JsonSection title="Return value" value={job.returnValue} /> : null}
      {job.stacktrace.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Stacktrace</h3>
          <pre className={PRE_CLASS}>{job.stacktrace.join('\n\n')}</pre>
        </section>
      ) : null}
      {job.logs.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Logs</h3>
          <pre className={PRE_CLASS}>{job.logs.join('\n')}</pre>
        </section>
      ) : null}
    </>
  );
}

/** Row-click drawer per frame 17: payload/result/error JSON, read-only. */
export function JobDetailSheet({
  queueName,
  jobId,
  onOpenChange,
}: {
  queueName: string;
  jobId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const jobQuery = useJob(queueName, jobId ?? '');

  return (
    <DetailDrawer
      open={jobId !== null}
      onOpenChange={onOpenChange}
      title={<span className="font-mono text-sm break-all">{jobId}</span>}
      badges={jobId ? <CopyButton value={jobId} label="Copy job id" /> : null}
      meta={<span>Payload, result and failure detail for this job.</span>}
    >
      <div className="flex flex-col gap-4">
        {jobQuery.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : jobQuery.error ? (
          <ErrorState error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />
        ) : jobQuery.data ? (
          <JobDetailBody job={jobQuery.data} />
        ) : null}
      </div>
    </DetailDrawer>
  );
}
