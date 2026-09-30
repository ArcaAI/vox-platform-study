'use client';

import { useState } from 'react';
import { IconCloudDownload } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatBytes, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { usePublisherJobs } from '../api/hooks';
import { isActiveJob } from '../api/lifecycle';
import type { PublisherJobView } from '../api/types';
import { CancelDownloadDialog, type CancelDownloadTarget } from './cancel-download-dialog';

const JOB_STATE_META: Record<PublisherJobView['state'], { label: string; role: StatusColorRole }> = {
  waiting: { label: 'Waiting', role: 'neutral' },
  active: { label: 'Active', role: 'info' },
  completed: { label: 'Completed', role: 'success' },
  failed: { label: 'Failed', role: 'destructive' },
  cancelled: { label: 'Cancelled', role: 'warning' },
};

function jobPercent(job: PublisherJobView): number | null {
  if (job.bytesDone == null || !job.bytesTotal) return null;
  return Math.min(100, Math.max(0, Math.round((job.bytesDone / job.bytesTotal) * 100)));
}

function JobRow({ job, onCancel }: { job: PublisherJobView; onCancel: (target: CancelDownloadTarget) => void }) {
  const meta = JOB_STATE_META[job.state];
  const percent = jobPercent(job);
  const cancellable = job.kind === 'download' && isActiveJob(job);
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{job.modelName}</span>
          <span className="text-muted-foreground font-mono text-xs">{job.modelSlug}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">{job.kind === 'download' ? 'Download' : 'Unregister'}</span>
          <StatusBadge label={meta.label} colorRole={meta.role} />
        </div>
      </div>
      {job.bytesDone != null ? (
        <div className="flex items-center gap-2">
          <Progress
            value={percent ?? undefined}
            aria-label={`${job.kind === 'download' ? 'Download' : 'Unregister'} progress for ${job.modelName}`}
            aria-valuetext={percent === null ? 'In progress' : `${percent}%`}
            className="w-40 shrink-0"
          />
          <span className="text-muted-foreground font-mono text-xs">
            {job.bytesTotal ? `${formatBytes(job.bytesDone)} / ${formatBytes(job.bytesTotal)}` : formatBytes(job.bytesDone)}
          </span>
        </div>
      ) : null}
      {job.error ? <p className="text-destructive text-xs">{job.error.message}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 text-xs">
          <span>Started {formatRelativeTime(job.startedAt)}</span>
          {job.startedBy ? (
            <span>
              by <span className="font-mono">{job.startedBy}</span>
            </span>
          ) : null}
        </span>
        {cancellable ? (
          <Button type="button" variant="outline" size="sm" aria-label={`Cancel download of ${job.modelName}`} onClick={() => onCancel({ id: job.aiModelId, name: job.modelName })}>
            Cancel
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Recent model-publisher jobs (TASK-1023): what is downloading or being removed, how far along, and who started it. */
export function DownloadJobsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const jobs = usePublisherJobs(open);
  const [cancelTarget, setCancelTarget] = useState<CancelDownloadTarget | null>(null);
  const rows = jobs.data ?? [];

  return (
    <>
      <DetailDrawer open={open} onOpenChange={onOpenChange} size="md" title="Download jobs" meta={<span>Updates every few seconds while a job is running.</span>}>
        {jobs.isLoading ? (
          <div role="status" aria-label="Loading jobs" className="flex flex-col gap-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-24 w-full" />
            ))}
          </div>
        ) : jobs.error ? (
          <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={IconCloudDownload} title="No download jobs yet" description="Registering a model from Hugging Face starts one." />
        ) : (
          <ul aria-label={`Jobs (${rows.length})`} className="flex flex-col gap-3">
            {rows.map((job) => (
              <JobRow key={job.jobId} job={job} onCancel={setCancelTarget} />
            ))}
          </ul>
        )}
      </DetailDrawer>
      <CancelDownloadDialog target={cancelTarget} open={cancelTarget !== null} onOpenChange={(next) => !next && setCancelTarget(null)} />
    </>
  );
}
