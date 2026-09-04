'use client';

import { useState } from 'react';
import { IconPlugConnected } from '@tabler/icons-react';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime, formatPercent } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import { transcriptionJobStreamPath, useTranscriptionJob } from '../api';
import type { TranscriptionJob } from '../api';
import { TranscriptionJobStatusBadge } from './job-status-badge';

/** Append-only event log cap (frame 35: "last received events"). */
const MAX_EVENTS = 20;

const STREAM_STATUS_META: Record<StreamStatus, { label: string; role: StatusColorRole }> = {
  idle: { label: 'Idle', role: 'neutral' },
  connecting: { label: 'Connecting', role: 'info' },
  open: { label: 'Live', role: 'success' },
  error: { label: 'Offline', role: 'destructive' },
  closed: { label: 'Closed', role: 'neutral' },
};

interface StreamEventLine {
  type: string;
  data: string;
}

function JobDetail({ job }: { job: TranscriptionJob }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground text-xs">Job</dt>
      <dd className="truncate font-mono text-xs" title={job.id}>
        {job.id}
      </dd>
      {/* TASK-861 — jobs are keyed to the ASR Agent VERSION; `pipelineId` is the deprecated key (null on agent-keyed rows). */}
      <dt className="text-muted-foreground text-xs">{job.agentVersionId ? 'Agent version' : 'Pipeline (deprecated)'}</dt>
      <dd className="truncate font-mono text-xs" title={job.agentVersionId ?? job.pipelineId ?? undefined}>
        {job.agentVersionId ?? job.pipelineId ?? '—'}
      </dd>
      <dt className="text-muted-foreground text-xs">Type</dt>
      <dd className="font-mono text-xs">{job.jobType}</dd>
      <dt className="text-muted-foreground text-xs">Status</dt>
      <dd>
        <TranscriptionJobStatusBadge status={job.status} />
      </dd>
      <dt className="text-muted-foreground text-xs">Progress</dt>
      <dd className="text-xs tabular-nums">{formatPercent(job.progress)}</dd>
      <dt className="text-muted-foreground text-xs">Queued</dt>
      <dd className="text-xs">{formatDateTime(job.queuedAt)}</dd>
      {job.completedAt ? (
        <>
          <dt className="text-muted-foreground text-xs">Completed</dt>
          <dd className="text-xs">{formatDateTime(job.completedAt)}</dd>
        </>
      ) : null}
      {job.errorMessage ? (
        <>
          <dt className="text-destructive text-xs">Error</dt>
          <dd className="text-destructive font-mono text-xs">
            {job.errorCode ? `${job.errorCode} \u00b7 ` : ''}
            {job.errorMessage}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * Frame 35 right panel — selected job detail plus the live SSE feed
 * (ticket-authenticated EventSource straight to the gateway; the route
 * declares `@StreamScope transcription_job`). The stream is
 * the primary live transport; if it exhausts its retry budget the detail
 * query re-polls every 5 s as the documented error fallback until the job
 * settles or the stream is reconnected.
 */
export function JobStreamPanel({ jobId }: { jobId: string }) {
  const [events, setEvents] = useState<StreamEventLine[]>([]);

  const stream = useEventStream({
    path: transcriptionJobStreamPath(jobId),
    scope: `transcription_job:${jobId}`,
    eventNames: ['status', 'progress', 'chunk', 'transcript', 'error'],
    onEvent: (type, data) => setEvents((current) => [...current.slice(-(MAX_EVENTS - 1)), { type, data }]),
  });

  const jobQuery = useTranscriptionJob(jobId, stream.status === 'error');

  const streamMeta = STREAM_STATUS_META[stream.status];

  let detail;
  if (jobQuery.isPending) {
    detail = (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-4 w-full" />
        ))}
      </div>
    );
  } else if (jobQuery.isError) {
    detail = <ErrorState error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />;
  } else {
    detail = <JobDetail job={jobQuery.data} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {detail}
      <section aria-label="Live stream" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Stream</h3>
          <StatusBadge label={streamMeta.label} colorRole={streamMeta.role} icon={<StatusDot colorRole={streamMeta.role} size="sm" />} />
          {stream.status === 'error' || stream.status === 'closed' ? (
            <Button variant="outline" size="sm" onClick={stream.reopen}>
              <IconPlugConnected aria-hidden />
              Reconnect
            </Button>
          ) : null}
        </div>
        {stream.error ? <p className="text-destructive text-xs">{stream.error}</p> : null}
        {events.length === 0 ? (
          <p className="text-muted-foreground text-xs">No stream events received yet.</p>
        ) : (
          <ol aria-label="Stream events" className="bg-muted/50 flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border p-2">
            {events.map((event, index) => (
              <li key={index} className="font-mono text-xs break-all">
                <span className="text-muted-foreground">[{event.type}]</span> {event.data}
              </li>
            ))}
          </ol>
        )}
        {stream.status === 'error' ? (
          <p className="text-muted-foreground text-xs">Stream unavailable — the job detail re-polls every 5 s until it settles.</p>
        ) : null}
      </section>
    </div>
  );
}

/** Panel shell: keeps the card + heading when nothing is selected yet. */
export function JobStreamCard({ jobId }: { jobId: string | null }) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-medium">
          Job stream{' '}
          <span aria-hidden className="text-muted-foreground font-normal">
            {'\u00b7'} SSE
          </span>
        </h2>
      </CardHeader>
      <CardContent>
        {jobId ? (
          // Remount per job: clears the event log and reopens the stream.
          <JobStreamPanel key={jobId} jobId={jobId} />
        ) : (
          <p className="text-muted-foreground text-sm">Select a job in the grid to open its detail and live stream.</p>
        )}
      </CardContent>
    </Card>
  );
}
