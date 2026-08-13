'use client';

/**
 * client-side batch queue for the live-transcription playground.
 *
 * The gateway takes ONE file per `POST /audio/transcription-jobs/transcribe`
 * and there is no batch endpoint, so N files are N independent jobs. This hook
 * owns that fan-out: one row per file, an upload per row, and a bounded number
 * of rows in flight.
 *
 * The concurrency slot is held for the WHOLE lifecycle — upload AND result
 * stream — not just the upload. The cap exists to bound concurrent SSE sockets
 * and worker load; an upload-only cap would still leave N streams open after a
 * 20-file drop. Same model as `useArcaBatchTranscription` in `@arcaai/vox`,
 * rebuilt on the console's BFF plane (proxied REST + ticketed SSE) because that
 * hook is bound to the SDK's api-key `AgenticClient`.
 *
 * The SSE leg deliberately lives OUTSIDE this hook: `useEventStream` is a hook
 * and cannot be called per queue item from here. The component renders one
 * headless binder per streaming row and feeds events back through
 * `applyStreamEvent` / `applyJob`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cancelTranscriptionJob, getTranscriptionJob, uploadBatchAudio } from '../api/client';
import { liveTranscriptionKeys } from '../api/keys';
import { TERMINAL_JOB_STATUSES } from '../api/types';
import type { JobStreamEnvelope, PlaygroundJobStatus, PlaygroundTranscriptionJob } from '../api/types';

export type BatchItemStatus = 'pending' | 'uploading' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** One transcript segment streamed back for a job. */
export interface BatchSegment {
  text: string;
  isFinal: boolean;
  startTime?: number;
  endTime?: number;
  speakerLabel?: string;
}

export interface BatchQueueItem {
  /** Stable client-side row id — NOT the job id, which only exists after upload. */
  id: string;
  fileName: string;
  size: number;
  status: BatchItemStatus;
  /**
   * 0 while the multipart POST is in flight, 100 once it resolved. The console
   * uploads through the shared fetch core (`@/shared/api`), which reports no
   * request-body progress events; a real percentage would need an XHR fork of
   * that core. The row shows an indeterminate "Uploading" state instead of a
   * fabricated number.
   */
  uploadProgress: number;
  jobId: string | null;
  /** Backend progress 0-100, from the job's `progress` SSE events. */
  jobProgress: number;
  segments: BatchSegment[];
  /**
   * While streaming: the joined FINAL segments. Once the job reaches a terminal
   * status: the job's own `resultText`, which is authoritative — streamed
   * chunks can be partial or dropped by a reconnect.
   */
  text: string;
  error: string | null;
}

export interface UseBatchQueueOptions {
  /** Snapshot onto every row at enqueue time, so a picker change mid-queue cannot rewrite history. */
  pipelineId: string | null;
  /** Rows in flight at once (upload + stream). */
  concurrency?: number;
  onItemCompleted?: (item: BatchQueueItem) => void;
  onItemFailed?: (item: BatchQueueItem) => void;
}

/** Default in-flight rows. Mirrors the SDK hook's default. */
export const DEFAULT_BATCH_CONCURRENCY = 2;

const ACTIVE_STATUSES: readonly BatchItemStatus[] = ['uploading', 'processing'];

/** Per-row handles that must never trigger a re-render. */
interface ItemRuntime {
  file: File;
  pipelineId: string | null;
  abort: AbortController | null;
}

function joinFinals(segments: BatchSegment[]): string {
  return segments
    .filter((segment) => segment.isFinal)
    .map((segment) => segment.text)
    .join(' ')
    .trim();
}

/** Both wire shapes: a `{ type, data }` envelope and a bare payload. */
function payloadOf(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as JobStreamEnvelope & Record<string, unknown>;
    return ((parsed.data as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toSegment(payload: Record<string, unknown>): BatchSegment | null {
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return null;
  return {
    text,
    isFinal: payload.isFinal !== false,
    startTime: typeof payload.startTime === 'number' ? payload.startTime : undefined,
    endTime: typeof payload.endTime === 'number' ? payload.endTime : undefined,
    speakerLabel: typeof payload.speakerLabel === 'string' ? payload.speakerLabel : typeof payload.speakerId === 'string' ? payload.speakerId : undefined,
  };
}

function terminalStatusOf(payload: Record<string, unknown>): PlaygroundJobStatus | null {
  const status = typeof payload.status === 'string' ? (payload.status.toUpperCase() as PlaygroundJobStatus) : null;
  return status && TERMINAL_JOB_STATUSES.includes(status) ? status : null;
}

export interface BatchQueueHandle {
  items: BatchQueueItem[];
  /** Appends rows; returns the new row ids in order (the caller selects the first). */
  enqueue: (files: File[] | FileList) => string[];
  cancel: (itemId: string) => void;
  retry: (itemId: string) => void;
  remove: (itemId: string) => void;
  clear: () => void;
  /** Rows currently holding a slot. */
  activeCount: number;
  /** Feed one SSE frame for a row (from the component's stream binder). */
  applyStreamEvent: (itemId: string, jobId: string, type: string, raw: string) => void;
  /** Feed a polled job payload for a row (SSE-down fallback). */
  applyJob: (itemId: string, job: PlaygroundTranscriptionJob) => void;
}

export function useBatchQueue({ pipelineId, concurrency = DEFAULT_BATCH_CONCURRENCY, onItemCompleted, onItemFailed }: UseBatchQueueOptions): BatchQueueHandle {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<BatchQueueItem[]>([]);

  const runtimeRef = useRef<Map<string, ItemRuntime>>(new Map());
  /** Rows already kicked off — the guard against a double start (StrictMode). */
  const startedRef = useRef<Set<string>>(new Set());
  /** Rows the user cancelled, so a rejected in-flight upload reads as cancelled, not failed. */
  const cancelledRef = useRef<Set<string>>(new Set());
  /** Rows already settled, so a late duplicate terminal frame is a no-op. */
  const settledRef = useRef<Set<string>>(new Set());
  const idCounterRef = useRef(0);
  const unmountedRef = useRef(false);

  // Latest props kept reachable from long-lived async callbacks without making
  // them dependencies. Written in an effect: a ref write during render is a
  // lint error here (react-hooks/refs) and the same pattern as `useEventStream`.
  const pipelineRef = useRef(pipelineId);
  const onCompletedRef = useRef(onItemCompleted);
  const onFailedRef = useRef(onItemFailed);
  useEffect(() => {
    pipelineRef.current = pipelineId;
    onCompletedRef.current = onItemCompleted;
    onFailedRef.current = onItemFailed;
  }, [pipelineId, onItemCompleted, onItemFailed]);

  const patch = useCallback((id: string, update: Partial<BatchQueueItem> | ((previous: BatchQueueItem) => Partial<BatchQueueItem>)) => {
    if (unmountedRef.current) return;
    setItems((previous) => previous.map((item) => (item.id === id ? { ...item, ...(typeof update === 'function' ? update(item) : update) } : item)));
  }, []);

  /** Fire a lifecycle callback with the row as it now stands. */
  const notify = useCallback((id: string, kind: 'completed' | 'failed') => {
    setItems((previous) => {
      const item = previous.find((candidate) => candidate.id === id);
      if (item) (kind === 'completed' ? onCompletedRef.current : onFailedRef.current)?.(item);
      return previous;
    });
  }, []);

  /**
   * Terminal transition. The job read is authoritative: streamed chunks can be
   * partial, so `resultText` replaces the joined segments when it exists.
   */
  const settle = useCallback(
    async (id: string, jobId: string, status: PlaygroundJobStatus) => {
      if (settledRef.current.has(id)) return;
      settledRef.current.add(id);
      const failed = status !== 'COMPLETED';
      try {
        const job = await getTranscriptionJob(jobId);
        patch(id, (previous) => ({
          status: failed ? 'failed' : 'completed',
          jobProgress: failed ? previous.jobProgress : 100,
          text: job.resultText?.trim() || previous.text,
          error: failed ? (job.errorMessage ?? `Job ${status.toLowerCase()}`) : null,
        }));
      } catch {
        // A failed read-back does not downgrade a completed job — the streamed
        // transcript is still worth keeping.
        patch(id, { status: failed ? 'failed' : 'completed', error: failed ? `Job ${status.toLowerCase()}` : null });
      }
      notify(id, failed ? 'failed' : 'completed');
      void queryClient.invalidateQueries({ queryKey: liveTranscriptionKeys.root });
    },
    [notify, patch, queryClient],
  );

  const run = useCallback(
    async (id: string) => {
      const runtime = runtimeRef.current.get(id);
      if (!runtime) return;
      if (!runtime.pipelineId) {
        patch(id, { status: 'failed', error: 'No pipeline was selected when this file was queued.' });
        notify(id, 'failed');
        return;
      }

      const abort = new AbortController();
      runtime.abort = abort;
      patch(id, { status: 'uploading', uploadProgress: 0, error: null });

      try {
        const created = await uploadBatchAudio({ file: runtime.file, pipelineId: runtime.pipelineId, signal: abort.signal });
        runtime.abort = null;
        if (cancelledRef.current.has(id)) {
          // Cancelled while the POST was in flight: the job exists on the
          // backend, so cancel it there rather than leaking a queued job.
          void cancelTranscriptionJob(created.id).catch(() => {});
          patch(id, { status: 'cancelled', jobId: created.id });
          return;
        }
        patch(id, { status: 'processing', uploadProgress: 100, jobId: created.id });
        void queryClient.invalidateQueries({ queryKey: liveTranscriptionKeys.root });
      } catch (error) {
        runtime.abort = null;
        if (cancelledRef.current.has(id) || abort.signal.aborted) {
          patch(id, { status: 'cancelled' });
          return;
        }
        patch(id, { status: 'failed', error: error instanceof Error ? error.message : 'Upload failed.' });
        notify(id, 'failed');
      }
    },
    [notify, patch, queryClient],
  );

  // Scheduler: start pending rows while a slot is free.
  useEffect(() => {
    const active = items.filter((item) => ACTIVE_STATUSES.includes(item.status)).length;
    let free = Math.max(0, concurrency - active);
    if (free === 0) return;
    for (const item of items) {
      if (free === 0) break;
      if (item.status !== 'pending' || startedRef.current.has(item.id)) continue;
      startedRef.current.add(item.id);
      free -= 1;
      void run(item.id);
    }
  }, [items, concurrency, run]);

  useEffect(() => {
    unmountedRef.current = false;
    const runtimes = runtimeRef.current;
    return () => {
      unmountedRef.current = true;
      for (const [, runtime] of runtimes) runtime.abort?.abort();
      runtimes.clear();
    };
  }, []);

  const enqueue = useCallback((files: File[] | FileList): string[] => {
    const list = Array.from(files as ArrayLike<File>);
    if (list.length === 0) return [];

    const created: BatchQueueItem[] = list.map((file) => {
      idCounterRef.current += 1;
      const id = `batch-item-${idCounterRef.current}`;
      runtimeRef.current.set(id, { file, pipelineId: pipelineRef.current, abort: null });
      return {
        id,
        fileName: file.name,
        size: file.size,
        status: 'pending',
        uploadProgress: 0,
        jobId: null,
        jobProgress: 0,
        segments: [],
        text: '',
        error: null,
      };
    });
    setItems((previous) => [...previous, ...created]);
    return created.map((item) => item.id);
  }, []);

  const stop = useCallback((itemId: string) => {
    const runtime = runtimeRef.current.get(itemId);
    runtime?.abort?.abort();
    if (runtime) runtime.abort = null;
  }, []);

  const cancel = useCallback(
    (itemId: string) => {
      cancelledRef.current.add(itemId);
      settledRef.current.add(itemId);
      setItems((previous) =>
        previous.map((item) => {
          if (item.id !== itemId) return item;
          if (item.status === 'completed' || item.status === 'cancelled') return item;
          if (item.jobId) void cancelTranscriptionJob(item.jobId).catch(() => {});
          return { ...item, status: 'cancelled' };
        }),
      );
      stop(itemId);
    },
    [stop],
  );

  const retry = useCallback(
    (itemId: string) => {
      cancelledRef.current.delete(itemId);
      startedRef.current.delete(itemId);
      settledRef.current.delete(itemId);
      stop(itemId);
      patch(itemId, { status: 'pending', uploadProgress: 0, jobId: null, jobProgress: 0, segments: [], text: '', error: null });
    },
    [patch, stop],
  );

  const remove = useCallback(
    (itemId: string) => {
      stop(itemId);
      runtimeRef.current.delete(itemId);
      startedRef.current.delete(itemId);
      cancelledRef.current.delete(itemId);
      settledRef.current.delete(itemId);
      setItems((previous) => previous.filter((item) => item.id !== itemId));
    },
    [stop],
  );

  const clear = useCallback(() => {
    for (const id of Array.from(runtimeRef.current.keys())) stop(id);
    runtimeRef.current.clear();
    startedRef.current.clear();
    cancelledRef.current.clear();
    settledRef.current.clear();
    setItems([]);
  }, [stop]);

  const applyStreamEvent = useCallback(
    (itemId: string, jobId: string, type: string, raw: string) => {
      const payload = payloadOf(raw);
      if (!payload) return;

      if (type === 'progress' && typeof payload.progress === 'number') {
        patch(itemId, { jobProgress: payload.progress });
        return;
      }
      if (type === 'chunk' || type === 'transcript' || type === 'message') {
        const segment = toSegment(payload);
        if (segment) {
          patch(itemId, (previous) => {
            const segments = [...previous.segments, segment];
            return { segments, text: joinFinals(segments) };
          });
          return;
        }
      }
      if (type === 'error') {
        const message = typeof payload.message === 'string' ? payload.message : 'The transcription job failed.';
        settledRef.current.add(itemId);
        patch(itemId, { status: 'failed', error: message });
        notify(itemId, 'failed');
        return;
      }
      const terminal = type === 'complete' ? 'COMPLETED' : terminalStatusOf(payload);
      if (terminal) void settle(itemId, jobId, terminal);
    },
    [notify, patch, settle],
  );

  const applyJob = useCallback(
    (itemId: string, job: PlaygroundTranscriptionJob) => {
      patch(itemId, { jobProgress: job.progress });
      if (TERMINAL_JOB_STATUSES.includes(job.status)) void settle(itemId, job.id, job.status);
    },
    [patch, settle],
  );

  const activeCount = useMemo(() => items.filter((item) => ACTIVE_STATUSES.includes(item.status)).length, [items]);

  return { items, enqueue, cancel, retry, remove, clear, activeCount, applyStreamEvent, applyJob };
}
