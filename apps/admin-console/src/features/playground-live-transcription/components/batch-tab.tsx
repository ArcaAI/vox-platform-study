'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  IconFileMusic,
  IconFileText,
  IconPlugConnectedX,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
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
  useCancelJob,
  useMyTranscriptionJobs,
  usePlaygroundJob,
  useRetryJob,
} from '../api';
import type { PlaygroundJobStatus, PlaygroundTranscriptionJob } from '../api';
import { useBatchQueue, type BatchItemStatus, type BatchQueueItem } from '../lib/batch-queue';
import { isStalledQuery } from '../lib/stalled-query';

const JOB_STATUS_META: Record<PlaygroundJobStatus, { label: string; role: StatusColorRole }> = {
  QUEUED: { label: 'Queued', role: 'info' },
  PROCESSING: { label: 'Running', role: 'primary' },
  COMPLETED: { label: 'Done', role: 'success' },
  FAILED: { label: 'Failed', role: 'destructive' },
  CANCELLED: { label: 'Cancelled', role: 'neutral' },
  DEAD: { label: 'Dead', role: 'destructive' },
};

const ITEM_STATUS_META: Record<BatchItemStatus, { label: string; role: StatusColorRole }> = {
  pending: { label: 'Waiting for a slot', role: 'neutral' },
  uploading: { label: 'Uploading', role: 'info' },
  processing: { label: 'Transcribing', role: 'primary' },
  completed: { label: 'Done', role: 'success' },
  failed: { label: 'Failed', role: 'destructive' },
  cancelled: { label: 'Cancelled', role: 'neutral' },
};

const STREAM_STATUS_META: Record<StreamStatus, { label: string; role: StatusColorRole }> = {
  idle: { label: 'Idle', role: 'neutral' },
  connecting: { label: 'Connecting', role: 'info' },
  open: { label: 'SSE live', role: 'success' },
  error: { label: 'Offline', role: 'destructive' },
  closed: { label: 'Closed', role: 'neutral' },
};

/** What the transcript panel is showing: a queue row, or a past job. */
type Selection = { kind: 'item'; id: string } | { kind: 'job'; id: string } | null;

function JobStatusChip({ status }: { status: PlaygroundJobStatus | string }) {
  const meta = JOB_STATUS_META[status as PlaygroundJobStatus] ?? { label: status, role: 'neutral' as StatusColorRole };
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}

function ItemStatusChip({ status }: { status: BatchItemStatus }) {
  const meta = ITEM_STATUS_META[status];
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />;
}

function validateAudioFile(file: File): string | null {
  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — the gateway rejects files over 100 MB (413).`;
  }
  if (file.type && !ACCEPTED_AUDIO_MIME_TYPES.includes(file.type)) {
    return `${file.name}: unsupported audio type ${file.type} — allowed: wav, mp3, mp4/m4a, ogg, flac, webm, aac.`;
  }
  return null;
}

/**
 * Multi-file staging area. Files are staged first (name + size + a per-file
 * remove control) and only enqueued on the explicit action, so a mis-drop is
 * always recoverable before anything reaches the gateway.
 */
function UploadCard({ pipelineId, onEnqueue }: { pipelineId: string | null; onEnqueue: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);

  function acceptFiles(candidates: ArrayLike<File> | null | undefined) {
    const incoming = Array.from(candidates ?? []);
    if (incoming.length === 0) return;
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const candidate of incoming) {
      const problem = validateAudioFile(candidate);
      if (problem) problems.push(problem);
      else accepted.push(candidate);
    }
    setRejections(problems);
    // Same file chosen twice in a row is one entry, not two uploads.
    setFiles((previous) => [...previous, ...accepted.filter((file) => !previous.some((kept) => kept.name === file.name && kept.size === file.size))]);
    if (inputRef.current) inputRef.current.value = '';
  }

  function removeFile(target: File) {
    setFiles((previous) => previous.filter((file) => file !== target));
  }

  function clearStaged() {
    setFiles([]);
    setRejections([]);
    if (inputRef.current) inputRef.current.value = '';
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    acceptFiles(event.dataTransfer?.files);
  }

  function handleUpload() {
    if (files.length === 0 || !pipelineId) return;
    onEnqueue(files);
    toast.success(files.length === 1 ? `${files[0].name} queued` : `${files.length} files queued`);
    clearStaged();
  }

  const disabledReason = !pipelineId
    ? 'Select a pipeline first — the picker above has not produced one yet.'
    : files.length === 0
      ? 'Choose one or more audio files to enable upload.'
      : null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">
          Batch upload{' '}
          <span aria-hidden className="text-muted-foreground font-normal">
            {'·'} one POST {'…'}/transcribe per file
          </span>
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Drag-drop with a single-pointer alternative (WCAG 2.5.7): the
                    zone is a label for the file input, so click/keyboard work too. */}
        <label
          htmlFor="batch-audio-input"
          data-testid="batch-drop-zone"
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
          className="border-input hover:bg-muted/50 focus-within:ring-ring/50 flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center focus-within:ring-[3px]"
        >
          <IconUpload aria-hidden className="text-muted-foreground size-6" />
          <span className="text-sm">
            Drag &amp; drop audio files here, or <span className="text-primary underline underline-offset-2">browse</span>
          </span>
          <span className="text-muted-foreground text-xs">
            wav {'·'} mp3 {'·'} mp4/m4a {'·'} ogg {'·'} flac {'·'} webm {'·'} aac {'—'} up to 100 MB each, one job
            per file
          </span>
        </label>
        <input
          ref={inputRef}
          id="batch-audio-input"
          aria-label="Audio files"
          type="file"
          multiple
          accept={ACCEPTED_AUDIO_MIME_TYPES.join(',')}
          className="sr-only"
          onChange={(event) => acceptFiles(event.target.files)}
        />

        {files.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {files.map((file) => (
              <li key={`${file.name}-${file.size}`} className="bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <IconFileMusic aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{formatBytes(file.size)}</span>
                <Button variant="ghost" size="icon-sm" aria-label={`Remove file ${file.name}`} onClick={() => removeFile(file)}>
                  <IconX aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {rejections.length > 0 ? (
          <div role="alert" className="text-destructive flex flex-col gap-1 text-sm">
            {rejections.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : null}

        <Button onClick={handleUpload} disabled={files.length === 0 || !pipelineId} aria-describedby={disabledReason ? 'batch-upload-reason' : undefined}>
          <IconUpload aria-hidden />
          Upload &amp; transcribe
          {files.length > 1 ? ` (${files.length})` : ''}
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
 * Headless SSE binder for ONE streaming row. `useEventStream` is a hook, so the
 * per-item stream cannot live inside `useBatchQueue`; rendering one binder per
 * row in `processing` keeps the socket count equal to the concurrency cap and
 * tears the stream down the moment the row settles.
 */
function JobStreamBinder({
  itemId,
  jobId,
  onEvent,
  onJob,
  onStatusChange,
}: {
  itemId: string;
  jobId: string;
  onEvent: (itemId: string, jobId: string, type: string, raw: string) => void;
  onJob: (itemId: string, job: PlaygroundTranscriptionJob) => void;
  onStatusChange: (itemId: string, status: StreamStatus) => void;
}) {
  const closeRef = useRef<() => void>(() => {});

  const stream = useEventStream({
    path: jobStreamPath(jobId),
    scope: `transcription_job:${jobId}`,
    eventNames: ['status', 'progress', 'chunk', 'transcript', 'complete', 'error'],
    onEvent: (type, data) => {
      onEvent(itemId, jobId, type, data);
      // The gateway completes the stream after a terminal status — close
      // before the EventSource error/retry loop kicks in.
      if (type === 'complete' || type === 'error') {
        closeRef.current();
        return;
      }
      if (type !== 'status') return;
      try {
        const status = (JSON.parse(data) as { data?: { status?: PlaygroundJobStatus }; status?: PlaygroundJobStatus }).data?.status;
        if (status && TERMINAL_JOB_STATUSES.includes(status)) closeRef.current();
      } catch {
        /* a malformed frame is not a reason to drop the stream */
      }
    },
  });
  useEffect(() => {
    closeRef.current = stream.close;
  }, [stream.close]);
  useEffect(() => {
    onStatusChange(itemId, stream.status);
  }, [itemId, stream.status, onStatusChange]);

  // Documented fallback: only while the stream is down does the row poll the
  // job, so a healthy stream costs exactly one connection and no polling.
  const fallback = usePlaygroundJob(stream.status === 'error' ? jobId : null, true);
  const job = fallback.data;
  useEffect(() => {
    if (job) onJob(itemId, job);
  }, [itemId, job, onJob]);

  return null;
}

function QueueRow({
  item,
  selected,
  streamStatus,
  onSelect,
  onCancel,
  onRetry,
  onRemove,
}: {
  item: BatchQueueItem;
  selected: boolean;
  streamStatus: StreamStatus | undefined;
  onSelect: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const canCancel = item.status === 'pending' || item.status === 'uploading' || item.status === 'processing';
  const canRetry = item.status === 'failed' || item.status === 'cancelled';
  const finalSegments = item.segments.filter((segment) => segment.isFinal).length;

  return (
    <li className={`flex flex-col gap-2 rounded-md border px-3 py-2 ${selected ? 'border-primary bg-muted/40' : 'bg-muted/20'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={onSelect} aria-pressed={selected} className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium">
          {item.fileName}
        </button>
        <ItemStatusChip status={item.status} />
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="tabular-nums">{formatBytes(item.size)}</span>
        <span className="font-mono">{item.jobId ?? 'no job yet'}</span>
        {finalSegments > 0 ? <span>{finalSegments} segments</span> : null}
        {item.status === 'processing' && streamStatus ? <span>{STREAM_STATUS_META[streamStatus].label}</span> : null}
      </div>

      {item.status === 'uploading' ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Spinner className="size-3" />
          Uploading through the gateway proxy{'…'}
        </p>
      ) : null}

      {item.status === 'processing' ? (
        <div className="flex items-center gap-3">
          <Progress value={item.jobProgress} aria-label={`Transcription progress for ${item.fileName}`} className="flex-1" />
          <span className="text-xs tabular-nums">{Math.round(item.jobProgress)}%</span>
        </div>
      ) : null}

      {item.error ? <p className="text-destructive text-xs">{item.error}</p> : null}

      <div className="flex flex-wrap gap-2">
        {canCancel ? (
          <Button variant="outline" size="sm" aria-label={`Cancel ${item.fileName}`} onClick={onCancel}>
            <IconX aria-hidden />
            Cancel
          </Button>
        ) : null}
        {canRetry ? (
          <Button variant="outline" size="sm" aria-label={`Retry ${item.fileName}`} onClick={onRetry}>
            <IconRefresh aria-hidden />
            Retry
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" aria-label={`Remove ${item.fileName} from the queue`} onClick={onRemove}>
          <IconTrash aria-hidden />
          Remove
        </Button>
      </div>
    </li>
  );
}

function QueueCard({
  items,
  selection,
  streamStatuses,
  onSelect,
  onCancel,
  onRetry,
  onRemove,
  onClear,
}: {
  items: BatchQueueItem[];
  selection: Selection;
  streamStatuses: Record<string, StreamStatus>;
  onSelect: (itemId: string) => void;
  onCancel: (itemId: string) => void;
  onRetry: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onClear: () => void;
}) {
  const empty = items.length === 0;

  return (
    <Card role="region" aria-label="Batch queue" className="gap-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm leading-none font-semibold">
          Queue ({items.length}){' '}
          <span aria-hidden className="text-muted-foreground font-normal">
            {'·'} 2 files in flight at a time
          </span>
        </h2>
        <Button variant="outline" size="sm" onClick={onClear} disabled={empty} aria-describedby={empty ? 'batch-clear-reason' : undefined}>
          <IconTrash aria-hidden />
          Clear queue
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {empty ? (
          <>
            <EmptyState
              icon={IconFileMusic}
              title="Nothing queued"
              description="Drop one or more audio files above — each one becomes its own transcription job."
            />
            <p id="batch-clear-reason" className="text-muted-foreground text-center text-xs">
              Nothing to clear while the queue is empty.
            </p>
          </>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                selected={selection?.kind === 'item' && selection.id === item.id}
                streamStatus={streamStatuses[item.id]}
                onSelect={() => onSelect(item.id)}
                onCancel={() => onCancel(item.id)}
                onRetry={() => onRetry(item.id)}
                onRemove={() => onRemove(item.id)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function formatOffset(value: number | undefined): string {
  if (value === undefined) return '—';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function TranscriptBody({ text }: { text: string }) {
  return <pre className="bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs leading-relaxed whitespace-pre-wrap">{text || '(empty transcript)'}</pre>;
}

/** Detail for a queue row: streamed segments while it runs, result text once settled. */
function ItemDetail({ item }: { item: BatchQueueItem }) {
  const waiting = item.status === 'pending' || item.status === 'uploading' || (item.status === 'processing' && item.segments.length === 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item.fileName}>
          {item.fileName}
        </span>
        <span className="text-muted-foreground font-mono text-xs">{item.jobId ?? 'no job yet'}</span>
        <ItemStatusChip status={item.status} />
      </div>

      {waiting ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : null}

      {item.segments.length > 0 && item.status !== 'completed' ? (
        <ol className="flex flex-col gap-2">
          {item.segments.map((segment, index) => (
            <li key={`${item.id}-segment-${index}`} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2 text-sm">
              <span className="text-muted-foreground font-mono text-xs">
                {formatOffset(segment.startTime)}
                {segment.speakerLabel ? ` · ${segment.speakerLabel}` : ''}
              </span>
              <span className={segment.isFinal ? '' : 'text-muted-foreground italic'}>{segment.text}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {item.status === 'completed' ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Result text</p>
          <TranscriptBody text={item.text} />
        </div>
      ) : null}

      {item.error ? <p className="text-destructive text-sm">{item.error}</p> : null}
    </div>
  );
}

/** Detail for a past job picked out of the recent-jobs table. */
function JobDetail({ jobId }: { jobId: string }) {
  const jobQuery = usePlaygroundJob(jobId);

  if (isStalledQuery(jobQuery)) {
    return (
      <EmptyState
        icon={IconPlugConnectedX}
        title="Transcript did not load"
        description="The request never left the browser — you may be offline. Retry to call GET /audio/transcription-jobs/:id."
        action={
          <Button variant="outline" size="sm" aria-label="Retry loading transcript" onClick={() => void jobQuery.refetch()}>
            <IconRefresh aria-hidden />
            Retry
          </Button>
        }
      />
    );
  }
  if (jobQuery.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  }
  if (jobQuery.isError) {
    return <ErrorState error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />;
  }

  const job = jobQuery.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{job.id}</span>
        <JobStatusChip status={job.status} />
        <span className="text-muted-foreground text-xs">{formatRelativeTime(job.completedAt ?? job.queuedAt)}</span>
      </div>
      {job.errorMessage ? (
        <p className="text-destructive font-mono text-xs">
          {job.errorCode ? `${job.errorCode} · ` : ''}
          {job.errorMessage}
        </p>
      ) : null}
      <TranscriptBody text={job.resultText ?? ''} />
    </div>
  );
}

function ResultPanel({ selection, items }: { selection: Selection; items: BatchQueueItem[] }) {
  const item = selection?.kind === 'item' ? (items.find((candidate) => candidate.id === selection.id) ?? null) : null;

  let body;
  if (selection?.kind === 'job') {
    body = <JobDetail key={selection.id} jobId={selection.id} />;
  } else if (item) {
    body = <ItemDetail item={item} />;
  } else {
    body = <EmptyState icon={IconFileText} title="Nothing selected" description="Pick a queued file or a past job to read its transcript here." />;
  }

  return (
    <Card role="region" aria-label="Transcript" className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">
          Transcript{' '}
          <span aria-hidden className="text-muted-foreground font-normal">
            {'·'} live segments, then the job{'’'}s result text
          </span>
        </h2>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function MyJobsStrip({ selection, onSelectJob }: { selection: Selection; onSelectJob: (jobId: string) => void }) {
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
        {rows.map((row) => {
          const selected = selection?.kind === 'job' && selection.id === row.id;
          return (
            <li
              key={row.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5 ${selected ? 'border-primary bg-muted/40' : 'bg-muted/30'}`}
            >
              <button
                type="button"
                aria-label={`Open transcript for job ${row.id}`}
                aria-pressed={selected}
                title={row.id}
                onClick={() => onSelectJob(row.id)}
                className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-xs"
              >
                {row.id}
              </button>
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
          );
        })}
      </ul>
    );
  }

  return (
    <Card role="region" aria-label="My jobs" className="gap-4">
      <CardHeader>
        <h2 className="text-sm leading-none font-semibold">
          My jobs{jobsQuery.data ? ` (${jobsQuery.data.total})` : ''}{' '}
          <span aria-hidden className="text-muted-foreground font-normal">
            {'·'} owner-scoped {'·'} select a row to read its transcript
          </span>
        </h2>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/**
 * Frame 51 batch tab: multi-file drag-drop upload → a bounded queue
 * (one gateway job per file) → a master/detail transcript panel fed either by a
 * queue row's live SSE segments or by a past job from the owner-scoped strip.
 */
export function BatchTab({ pipelineId }: { pipelineId: string | null }) {
  const [selection, setSelection] = useState<Selection>(null);
  const [streamStatuses, setStreamStatuses] = useState<Record<string, StreamStatus>>({});

  const queue = useBatchQueue({
    pipelineId,
    onItemCompleted: (item) => toast.success(`${item.fileName} transcribed`),
    onItemFailed: (item) => toast.error(`${item.fileName} failed — ${item.error ?? 'unknown error'}`),
  });

  // Stable identity: the binder reports its status from an effect keyed on it.
  const handleStreamStatus = useCallback((itemId: string, status: StreamStatus) => {
    setStreamStatuses((previous) => (previous[itemId] === status ? previous : { ...previous, [itemId]: status }));
  }, []);

  function handleEnqueue(files: File[]) {
    const ids = queue.enqueue(files);
    // Auto-select the first file of the drop so the panel is never blank
    // right after an upload.
    if (ids.length > 0) setSelection({ kind: 'item', id: ids[0] });
  }

  function nameOf(itemId: string) {
    return queue.items.find((item) => item.id === itemId)?.fileName ?? 'File';
  }

  function handleCancel(itemId: string) {
    const name = nameOf(itemId);
    queue.cancel(itemId);
    toast.success(`${name} cancelled`);
  }

  function handleRetry(itemId: string) {
    const name = nameOf(itemId);
    queue.retry(itemId);
    toast.success(`${name} queued for another attempt`);
  }

  function handleRemove(itemId: string) {
    queue.remove(itemId);
    setSelection((previous) => (previous?.kind === 'item' && previous.id === itemId ? null : previous));
  }

  function handleClear() {
    queue.clear();
    setSelection((previous) => (previous?.kind === 'item' ? null : previous));
    toast.success('Queue cleared');
  }

  const streaming = queue.items.filter((item) => item.status === 'processing' && item.jobId);

  return (
    <div className="flex flex-col gap-4">
      {streaming.map((item) => (
        <JobStreamBinder
          key={item.id}
          itemId={item.id}
          jobId={item.jobId as string}
          onEvent={queue.applyStreamEvent}
          onJob={queue.applyJob}
          onStatusChange={handleStreamStatus}
        />
      ))}

      <UploadCard pipelineId={pipelineId} onEnqueue={handleEnqueue} />
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <QueueCard
          items={queue.items}
          selection={selection}
          streamStatuses={streamStatuses}
          onSelect={(itemId) => setSelection({ kind: 'item', id: itemId })}
          onCancel={handleCancel}
          onRetry={handleRetry}
          onRemove={handleRemove}
          onClear={handleClear}
        />
        <ResultPanel selection={selection} items={queue.items} />
      </div>
      <MyJobsStrip selection={selection} onSelectJob={(jobId) => setSelection({ kind: 'job', id: jobId })} />
    </div>
  );
}
