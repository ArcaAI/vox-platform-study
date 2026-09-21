'use client';

import { useEffect, useState } from 'react';
import { IconPlugConnected } from '@tabler/icons-react';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime, formatPercent } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import { TERMINAL_JOB_STATUSES, transcriptionJobStreamPath, useTranscriptionJob } from '../api';
import type { TranscriptionJob, TranscriptionJobStatus } from '../api';
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

/**
 * TASK-999 — pulls a terminal job status out of an SSE frame, tolerating the one shape this
 * route actually sends: `TranscriptionRealtimeService` always wraps the payload as
 * `{ type, data: { jobId, status, ... } }`, whether it arrives on a NAMED `status` event (a live
 * job forwarded from Redis) or on the DEFAULT `message` event (the reconnect-to-an-already-
 * terminal-job branch, `transcriptionRealtime.service.ts:158-173`, which is exactly the frame
 * the console was looping on). A bare `{ status }` is accepted too, defensively, since nothing
 * here should assume the wrapper can never change shape upstream.
 */
function extractTerminalStatus(raw: string): TranscriptionJobStatus | null {
  let parsed: { status?: unknown; data?: { status?: unknown } };
  try {
    parsed = JSON.parse(raw) as { status?: unknown; data?: { status?: unknown } };
  } catch {
    return null;
  }
  const status = parsed.data && typeof parsed.data === 'object' ? parsed.data.status : parsed.status;
  return typeof status === 'string' && (TERMINAL_JOB_STATUSES as readonly string[]).includes(status) ? (status as TranscriptionJobStatus) : null;
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
  const [terminalStatus, setTerminalStatus] = useState<TranscriptionJobStatus | null>(null);
  // null = not yet known (withhold the subscription); false = confirmed still running (the
  // stream may open); true = confirmed already terminal — this mount never subscribes at all,
  // it just renders the REST detail below. Decided ONCE, from `jobQuery` (see the render-time
  // update below), never re-armed for the same mount (a fresh `jobId` always gets a fresh
  // mount — `JobStreamCard` remounts `JobStreamPanel` with `key={jobId}`).
  const [mountKnownTerminal, setMountKnownTerminal] = useState<boolean | null>(null);

  const stream = useEventStream({
    path: transcriptionJobStreamPath(jobId),
    scope: `transcription_job:${jobId}`,
    eventNames: ['status', 'progress', 'chunk', 'transcript', 'error'],
    onEvent: (type, data) => {
      setEvents((current) => [...current.slice(-(MAX_EVENTS - 1)), { type, data }]);
      const status = extractTerminalStatus(data);
      if (status) setTerminalStatus(status);
    },
    // TASK-999 — never open a subscription the gateway is just going to complete immediately
    // (`TranscriptionRealtimeService.subscribeToJob`'s "already finished" branch): that is the
    // exact frame the reconnect loop was chasing.
    enabled: mountKnownTerminal === false,
  });

  const jobQuery = useTranscriptionJob(jobId, stream.status === 'error');

  // Render-time derived state (React's documented "resetting state when a prop changes" idiom,
  // used identically by `useDnaJobProgress`/`usePreSummaryStream` elsewhere in this console) —
  // NOT an effect, so a still-running job's stream can open on the very render its status
  // resolves rather than one tick late. A failed initial read (`isError`) still unblocks the
  // stream: an unreadable status is not evidence the job is terminal.
  if (mountKnownTerminal === null && (jobQuery.data || jobQuery.isError)) {
    setMountKnownTerminal(jobQuery.data ? TERMINAL_JOB_STATUSES.includes(jobQuery.data.status) : false);
  }

  // TASK-999 — a terminal `status` frame stops the stream eagerly, the house pattern
  // (`use-task-stream.ts`): single-use tickets, no zombie subscription left open once the
  // gateway has already ended the response.
  const terminal = !!terminalStatus;
  const closeStream = stream.close;
  useEffect(() => {
    if (terminal) closeStream();
  }, [terminal, closeStream]);

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
