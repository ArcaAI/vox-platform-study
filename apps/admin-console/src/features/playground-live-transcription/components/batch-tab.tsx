'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { IconFileMusic, IconPlugConnected, IconPlugConnectedX, IconRefresh, IconUpload, IconX } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { formatBytes, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import {
  ACCEPTED_AUDIO_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  TERMINAL_JOB_STATUSES,
  jobStreamPath,
  liveTranscriptionKeys,
  useBatchUpload,
  useCancelJob,
  useMyTranscriptionJobs,
  usePlaygroundJob,
  useRetryJob,
} from '../api';
import type { JobStreamEnvelope, PlaygroundJobStatus } from '../api';
import { isStalledQuery } from '../lib/stalled-query';

const JOB_STATUS_META: Record<PlaygroundJobStatus, { label: string; role: StatusColorRole }> = {
  QUEUED: { label: 'Queued', role: 'info' },
  PROCESSING: { label: 'Running', role: 'primary' },
  COMPLETED: { label: 'Done', role: 'success' },
  FAILED: { label: 'Failed', role: 'destructive' },
  CANCELLED: { label: 'Cancelled', role: 'neutral' },
  DEAD: { label: 'Dead', role: 'destructive' },
};

const STREAM_STATUS_META: Record<StreamStatus, { label: string; role: StatusColorRole }> = {
  idle: { label: 'Idle', role: 'neutral' },
  connecting: { label: 'Connecting', role: 'info' },
  open: { label: 'SSE live', role: 'success' },
  error: { label: 'Offline', role: 'destructive' },
  closed: { label: 'Closed', role: 'neutral' },
};

function JobStatusChip({ status }: { status: PlaygroundJobStatus | string }) {
  const meta = JOB_STATUS_META[status as PlaygroundJobStatus] ?? { label: status, role: 'neutral' as StatusColorRole };
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}

function validateAudioFile(file: File): string | null {
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — the gateway rejects files over 100 MB (413).`;
  }
  if (file.type && !ACCEPTED_AUDIO_MIME_TYPES.includes(file.type)) {
    return `Unsupported audio type ${file.type} — allowed: wav, mp3, mp4/m4a, ogg, flac, webm, aac.`;
  }
  return null;
}

function UploadCard({ pipelineId, onJobCreated }: { pipelineId: string | null; onJobCreated: (jobId: string) => void }) {
  const upload = useBatchUpload();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  function acceptFile(candidate: File | null) {
    if (!candidate) return;
    const problem = validateAudioFile(candidate);
    setValidationError(problem);
    setFile(problem ? null : candidate);
  }

  function clearFile() {
    setFile(null);
    setValidationError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    acceptFile(event.dataTransfer.files?.[0] ?? null);
  }

  function handleUpload() {
    if (!file || !pipelineId) return;
    upload.mutate(
      { file, pipelineId },
      {
        onSuccess: (created) => {
          toast.success(`Batch job ${created.id} queued`);
          onJobCreated(created.id);
          clearFile();
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Upload failed.'),
      },
    );
  }

  const disabledReason = !pipelineId
    ? 'Select a pipeline first — the picker above has not produced one yet.'
    : !file
      ? 'Choose an audio file to enable upload.'
      : null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">
          Batch upload{' '}
          <span aria-hidden className="text-muted-foreground font-normal">
            {'\u00b7'} POST {'\u2026'}/transcribe
          </span>
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Drag-drop with a single-pointer alternative (WCAG 2.5.7): the
                    zone is a label for the file input, so click/keyboard work too. */}
        <label
          htmlFor="batch-audio-input"
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
          className="border-input hover:bg-muted/50 focus-within:ring-ring/50 flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center focus-within:ring-[3px]"
        >
          <IconUpload aria-hidden className="text-muted-foreground size-6" />
          <span className="text-sm">
            Drag &amp; drop an audio file here, or <span className="text-primary underline underline-offset-2">browse</span>
          </span>
          <span className="text-muted-foreground text-xs">
            wav {'\u00b7'} mp3 {'\u00b7'} mp4/m4a {'\u00b7'} ogg {'\u00b7'} flac {'\u00b7'} webm {'\u00b7'} aac {'\u2014'} up to 100 MB, multipart
            field {'\u201c'}file{'\u201d'}
          </span>
        </label>
        <input
          ref={inputRef}
          id="batch-audio-input"
          aria-label="Audio file"
          type="file"
          accept={ACCEPTED_AUDIO_MIME_TYPES.join(',')}
          className="sr-only"
          onChange={(event) => acceptFile(event.target.files?.[0] ?? null)}
        />

        {file ? (
          <div className="bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <IconFileMusic aria-hidden className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={file.name}>
              {file.name}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatBytes(file.size)}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Remove file" onClick={clearFile}>
              <IconX aria-hidden />
            </Button>
          </div>
        ) : null}

        {validationError ? (
          <p role="alert" className="text-destructive text-sm">
            {validationError}
          </p>
        ) : null}

        <Button
          onClick={handleUpload}
          disabled={!file || !pipelineId || upload.isPending}
          aria-describedby={disabledReason ? 'batch-upload-reason' : undefined}
        >
          {upload.isPending ? <Spinner /> : <IconUpload aria-hidden />}
          Upload &amp; transcribe
        </Button>
        {/* Rule 11 §5: a disabled control must state its reason. */}
        {disabledReason ? (
          <p id="batch-upload-reason" className="text-muted-foreground text-xs">
            {disabledReason}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Frame 51 job card: detail facts + the ticket-authenticated SSE feed
 * (status/progress/chunk events). The stream is the live transport; on stream
 * error the detail re-polls every 5 s until the job settles.
 */
function ActiveJobCard({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const [liveProgress, setLiveProgress] = useState<number | null>(null);
  const [liveStatus, setLiveStatus] = useState<PlaygroundJobStatus | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Events only arrive after useEventStream's connect effect runs, so
  // assigning the close handle in an effect is always early enough.
  const closeStreamRef = useRef<() => void>(() => {});

  const stream = useEventStream({
    path: jobStreamPath(jobId),
    scope: `transcription_job:${jobId}`,
    eventNames: ['status', 'progress', 'chunk', 'transcript', 'error'],
    onEvent: (type, data) => {
      let envelope: JobStreamEnvelope | null = null;
      try {
        envelope = JSON.parse(data) as JobStreamEnvelope;
      } catch {
        return;
      }
      if (type === 'progress' && typeof envelope.data?.progress === 'number') {
        setLiveProgress(envelope.data.progress);
      }
      if (type === 'status' && envelope.data?.status) {
        const status = envelope.data.status;
        setLiveStatus(status);
        if (TERMINAL_JOB_STATUSES.includes(status)) {
          // The gateway completes the stream after a terminal status —
          // close before the EventSource error/retry loop kicks in.
          closeStreamRef.current();
          void queryClient.invalidateQueries({ queryKey: liveTranscriptionKeys.root });
        }
      }
      if (type === 'error' && envelope.data?.message) {
        setStreamError(String(envelope.data.message));
      }
    },
  });
  useEffect(() => {
    closeStreamRef.current = stream.close;
  }, [stream.close]);

  const jobQuery = usePlaygroundJob(jobId, stream.status === 'error');
  const job = jobQuery.data;

  const status = liveStatus ?? job?.status ?? 'QUEUED';
  const progress = liveProgress ?? job?.progress ?? 0;
  const streamMeta = STREAM_STATUS_META[stream.status];

  return (
    <Card role="region" aria-label="Active batch job" className="gap-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm leading-none font-semibold">
          Active batch job{' '}
          <span aria-hidden className="text-muted-foreground font-normal">
            {'\u00b7'} SSE :id/stream
          </span>
        </h2>
        <StatusBadge label={streamMeta.label} colorRole={streamMeta.role} icon={<StatusDot colorRole={streamMeta.role} size="sm" />} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {jobQuery.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{jobId}</span>
              <JobStatusChip status={status} />
            </div>
            <div className="flex items-center gap-3">
              <Progress value={progress} aria-label="Job progress" className="flex-1" />
              <span className="text-xs tabular-nums">{Math.round(progress)}%</span>
            </div>
            {job?.errorMessage ? (
              <p className="text-destructive font-mono text-xs">
                {job.errorCode ? `${job.errorCode} \u00b7 ` : ''}
                {job.errorMessage}
              </p>
            ) : null}
            {streamError ? <p className="text-destructive text-xs">{streamError}</p> : null}
            {stream.status === 'error' ? (
              <div className="flex items-center gap-2">
                <p className="text-muted-foreground flex-1 text-xs">Stream unavailable {'\u2014'} polling every 5 s until the job settles.</p>
                <Button variant="outline" size="sm" onClick={stream.reopen}>
                  <IconPlugConnected aria-hidden />
                  Reconnect
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MyJobsStrip() {
  const jobsQuery = useMyTranscriptionJobs();
  const cancelJob = useCancelJob();
  const retryJob = useRetryJob();

  const rows = jobsQuery.data?.data ?? [];

  function handleCancel(id: string) {
    cancelJob.mutate(id, {
      onSuccess: () => toast.success(`Job ${id} cancelled`),
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Cancel failed.'),
    });
  }

  function handleRetry(id: string) {
    retryJob.mutate(id, {
      onSuccess: () => toast.success(`Job ${id} queued for retry`),
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Retry failed.'),
    });
  }

  let body;
  // BUG-014: `isPending` alone also covers "never started" and
  // "offline-paused", neither of which ever resolves — checked FIRST because a
  // stalled query satisfies both branches (rules 10 and 11 §4).
  if (isStalledQuery(jobsQuery)) {
    body = (
      <EmptyState
        icon={IconPlugConnectedX}
        title="Jobs did not load"
        description="The request never left the browser — you may be offline, or this panel did not finish loading. Retry to call GET /audio/transcription-jobs."
        action={
          <Button variant="outline" size="sm" aria-label="Retry loading jobs" onClick={() => void jobsQuery.refetch()}>
            <IconRefresh aria-hidden />
            Retry
          </Button>
        }
      />
    );
  } else if (jobsQuery.isPending) {
    body = (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    );
  } else if (jobsQuery.isError) {
    body = <ErrorState error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} />;
  } else if (rows.length === 0) {
    body = (
      <EmptyState icon={IconFileMusic} title="No batch jobs yet" description="Drop an audio file above to create your first transcription job." />
    );
  } else {
    body = (
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row.id} className="bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={row.id}>
              {row.id}
            </span>
            <JobStatusChip status={row.status} />
            <span className="text-muted-foreground text-xs tabular-nums">{Math.round(row.progress)}%</span>
            <span className="text-muted-foreground text-xs">{formatRelativeTime(row.queuedAt)}</span>
            {row.status === 'QUEUED' || row.status === 'PROCESSING' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Cancel job ${row.id}`}
                disabled={cancelJob.isPending}
                onClick={() => handleCancel(row.id)}
              >
                <IconX aria-hidden />
              </Button>
            ) : null}
            {row.status === 'FAILED' ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Retry job ${row.id}`}
                disabled={retryJob.isPending}
                onClick={() => handleRetry(row.id)}
              >
                <IconRefresh aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card role="region" aria-label="My jobs" className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">
          My jobs{jobsQuery.data ? ` (${jobsQuery.data.total})` : ''}{' '}
          <span aria-hidden className="text-muted-foreground font-normal">
            {'\u00b7'} owner-scoped {'\u00b7'} GET /audio/transcription-jobs
          </span>
        </h2>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/**
 * Frame 51 batch tab: drag-drop upload (≤100 MB audio) → job card with SSE
 * progress → my-jobs strip (caller's OWN jobs) with cancel/retry.
 */
export function BatchTab({
  pipelineId,
  activeJobId,
  onActiveJobChange,
}: {
  pipelineId: string | null;
  activeJobId: string | null;
  onActiveJobChange: (jobId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <UploadCard pipelineId={pipelineId} onJobCreated={onActiveJobChange} />
        {activeJobId ? (
          // Remount per job: clears live progress and reopens the stream.
          <ActiveJobCard key={activeJobId} jobId={activeJobId} />
        ) : null}
      </div>
      <MyJobsStrip />
    </div>
  );
}
