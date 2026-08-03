'use client';

/**
 * @arcaai/vox/compat - useArcaBatchTranscription
 *
 * Batch (pre-recorded file) transcription for the compat surface (TASK-603).
 *
 * v1's `useArcaSpeechToText` shipped a single-file `uploadAudioFile()` +
 * `getTranscriptionStatus()` polling pair. Both are still honoured verbatim on
 * that hook (nothing was removed); this hook is the ADDITIVE, v2-native queue a
 * migrating app actually wants — many files, per-file progress, per-file live
 * results — in the same category as `useArcaSttProvider`: a compat-entry hook
 * with no v1 ancestor.
 *
 * It MUST live in (and be exported from) the compat entry. `@arcaai/vox/compat`
 * is its own tsup entry built with `splitting: false`, so the Zustand React
 * context does NOT cross entry bundles: a hook imported from `@arcaai/vox` while
 * `<ArcaCompatProvider>` came from `@arcaai/vox/compat` reads a DIFFERENT context
 * instance and throws "must be used within an <AgenticProvider>".
 *
 * Composition, all public v2 surface:
 *  - `FileTranscriptionService` — multipart upload with progress, job fetch,
 *    cancel, and the job stream URL.
 *  - `SSEClient` — job results.
 *
 * ⚠️ TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 *  1. `new SSEClient(scope, apiClient, logger)` — the 3-argument form. The
 *     legacy 1-arg `new SSEClient(logger)` is explicitly BLOCKED inside
 *     `openWithTicket` and resolves to a permanent connection failure; the
 *     deprecated `apps/ui-playground/src/hooks/use-file-transcription.ts` still
 *     uses it, which is why its batch stream never delivers a transcript.
 *  2. The scope is PER JOB — `transcription_job:<jobId>`. The gateway route
 *     carries `@StreamScope({ namespace: 'transcription_job', param: 'id' })`
 *     and the guard requires the ticket's scope to equal exactly that, so a
 *     free-form scope string is a 401, not a warning.
 *
 * Both are locked by `__tests__/useArcaBatchTranscription.test.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTranscriptionService } from '../core/FileTranscriptionService';
import { SSEClient, type SSEApiClient } from '../core/SSEClient';
import { transcriptionJobScopeFor } from '../core/constants';
import { useAgenticStore, selectApiClient, selectLogger } from '../store/agenticStore';
import type { TranscriptionJobResponse } from '../types/stt';
import type { ErrorInfo } from './types';

/** Lifecycle of one queued file. */
export type BatchItemStatus = 'pending' | 'uploading' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** One transcript segment streamed back for a job. */
export interface BatchTranscriptSegment {
  text: string;
  isFinal: boolean;
  startTime?: number;
  endTime?: number;
  speakerId?: string;
  speakerLabel?: string;
}

/** One row of the queue. `File` is deliberately NOT exposed — retry keeps it internally. */
export interface BatchQueueItem {
  /** Stable client-side queue id (not the job id — that only exists after upload). */
  id: string;
  fileName: string;
  /** File size in bytes. */
  size: number;
  status: BatchItemStatus;
  /** 0–100, upload only. Backend progress is reported through `job.progress`. */
  uploadProgress: number;
  /** Backend job id, once the upload returned one. */
  jobId: string | null;
  /** Segments streamed so far, in arrival order. */
  segments: BatchTranscriptSegment[];
  /**
   * Transcript text. While streaming this is the joined FINAL segments; once the
   * job completes it is the job's own `resultText` — the authoritative version,
   * since streamed chunks can be partial.
   */
  text: string;
  error: string | null;
  /** Last job payload seen (upload response, then the terminal fetch). */
  job: TranscriptionJobResponse | null;
}

/** Upload options. Given per-hook as defaults and/or per-`enqueue` as an override. */
export interface BatchTranscriptionOptions {
  /** ASR pipeline id. Required — resolved from the per-enqueue value, else the hook default. */
  pipelineId?: string;
  /** ISO 639-1 language code (or a code-switch mode id the pipeline understands). */
  language?: string;
  /** Optional consultation to link every job in this batch to. */
  consultationId?: string;
}

export interface UseArcaBatchTranscriptionProps {
  /** Defaults applied to every `enqueue` that does not override them. */
  options?: BatchTranscriptionOptions;
  /**
   * How many files may be in flight at once, counting BOTH the upload and the
   * result stream. Default 2 — a 20-file drop must not open 20 sockets.
   */
  concurrency?: number;
  onJobCompleted?: (item: BatchQueueItem) => void;
  onError?: (error: ErrorInfo, itemId: string) => void;
}

export interface UseArcaBatchTranscriptionReturn {
  items: BatchQueueItem[];
  /** Append files to the queue. Returns the new queue-item ids, in order. */
  enqueue: (files: File[] | FileList, options?: BatchTranscriptionOptions) => string[];
  /** Abort the upload, or cancel the backend job and drop the stream. */
  cancel: (itemId: string) => void;
  /** Re-run a failed/cancelled item from the top. */
  retry: (itemId: string) => void;
  /** Drop one item (stopping it first). */
  remove: (itemId: string) => void;
  /** Drop every item (stopping each first). */
  clear: () => void;
  isUploading: boolean;
  isStreaming: boolean;
  /** Items currently holding a concurrency slot. */
  activeCount: number;
  /** Most recent failure, for a single console-level error surface. */
  error: ErrorInfo | null;
}

/** Per-item runtime handles. Kept in a ref: none of it belongs in render state. */
interface ItemRuntime {
  file: File;
  options: BatchTranscriptionOptions;
  service: FileTranscriptionService | null;
  abort: AbortController | null;
  sse: SSEClient | null;
}

const DEFAULT_CONCURRENCY = 2;
const ACTIVE_STATUSES: BatchItemStatus[] = ['uploading', 'processing'];

function toErrorInfo(err: unknown, category: ErrorInfo['category'] = 'processing'): ErrorInfo {
  return {
    code: 'BATCH_TRANSCRIPTION_ERROR',
    message: err instanceof Error ? err.message : String(err),
    severity: 'high',
    category,
  };
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Join the FINAL segments — the interim ones are hypotheses, not transcript. */
function joinFinals(segments: BatchTranscriptSegment[]): string {
  return segments
    .filter((s) => s.isFinal)
    .map((s) => s.text)
    .join(' ')
    .trim();
}

/**
 * Parse one SSE payload into a segment.
 *
 * Accepts BOTH shapes the gateway emits — a bare payload and a
 * `{type, data}` envelope — because the job stream carries named events
 * (`chunk`/`status`/`complete`/`error`) while a generic `message` frame nests
 * the same body under `data`.
 */
function parseSegment(raw: string): BatchTranscriptSegment | null {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    payload = ((parsed.data as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return null;
  const speakerId = typeof payload.speakerId === 'string' ? payload.speakerId : typeof payload.speaker === 'string' ? payload.speaker : undefined;
  return {
    text,
    isFinal: payload.isFinal !== false,
    startTime: asNumber(payload.startTime),
    endTime: asNumber(payload.endTime),
    speakerId: speakerId?.trim() || undefined,
    speakerLabel: typeof payload.speakerLabel === 'string' ? payload.speakerLabel : undefined,
  };
}

/** Read a terminal status out of either payload shape. `null` when there is none. */
function parseStatus(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const payload = ((parsed.data as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
    const status = payload.status ?? parsed.status;
    return typeof status === 'string' ? status.toUpperCase() : null;
  } catch {
    return null;
  }
}

function parseMessage(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const payload = ((parsed.data as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
    return typeof payload.message === 'string' ? payload.message : null;
  } catch {
    return null;
  }
}

export function useArcaBatchTranscription(props: UseArcaBatchTranscriptionProps = {}): UseArcaBatchTranscriptionReturn {
  const { concurrency = DEFAULT_CONCURRENCY, onJobCompleted, onError } = props;
  const apiClient = useAgenticStore(selectApiClient);
  const logger = useAgenticStore(selectLogger);

  const [items, setItems] = useState<BatchQueueItem[]>([]);
  const [error, setError] = useState<ErrorInfo | null>(null);

  const runtimeRef = useRef<Map<string, ItemRuntime>>(new Map());
  /** Items whose run has been kicked off — the guard against a double start (StrictMode). */
  const startedRef = useRef<Set<string>>(new Set());
  /** Items the user cancelled, so a rejected in-flight upload reads as `cancelled`, not `failed`. */
  const cancelledRef = useRef<Set<string>>(new Set());
  const idCounterRef = useRef(0);
  const unmountedRef = useRef(false);

  // Keep the latest values reachable from long-lived async callbacks without
  // making them dependencies (same "keep it fresh" ref pattern as
  // `useArcaSpeechToText`'s `onTranscriptRef`).
  const defaultOptionsRef = useRef(props.options);
  defaultOptionsRef.current = props.options;
  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;
  const loggerRef = useRef(logger);
  loggerRef.current = logger;
  const onJobCompletedRef = useRef(onJobCompleted);
  onJobCompletedRef.current = onJobCompleted;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const patchItem = useCallback((id: string, patch: Partial<BatchQueueItem> | ((prev: BatchQueueItem) => Partial<BatchQueueItem>)) => {
    if (unmountedRef.current) return;
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...(typeof patch === 'function' ? patch(item) : patch) } : item)));
  }, []);

  const failItem = useCallback(
    (id: string, err: unknown, category: ErrorInfo['category'] = 'processing') => {
      const info = toErrorInfo(err, category);
      patchItem(id, { status: 'failed', error: info.message });
      setError(info);
      onErrorRef.current?.(info, id);
    },
    [patchItem],
  );

  /** Release an item's transport handles without touching its render state. */
  const teardown = useCallback((id: string, opts: { abortUpload?: boolean } = {}) => {
    const runtime = runtimeRef.current.get(id);
    if (!runtime) return;
    if (opts.abortUpload) runtime.abort?.abort();
    runtime.abort = null;
    runtime.sse?.disconnect();
    runtime.sse = null;
  }, []);

  // ---------------------------------------------------------------------------
  // Result stream
  // ---------------------------------------------------------------------------
  const connectStream = useCallback(
    (id: string, jobId: string, service: FileTranscriptionService) => {
      const client = apiClientRef.current;
      if (!client) return;

      // Per-job ticket scope — see the file header. A generic scope is a 401.
      const sse = new SSEClient(transcriptionJobScopeFor(jobId), client as unknown as SSEApiClient, loggerRef.current ?? undefined);
      const runtime = runtimeRef.current.get(id);
      if (runtime) runtime.sse = sse;

      const appendSegment = (raw: string) => {
        const segment = parseSegment(raw);
        if (!segment) return;
        patchItem(id, (prev) => {
          const segments = [...prev.segments, segment];
          return { segments, text: joinFinals(segments) };
        });
      };

      const finish = async () => {
        teardown(id);
        // The job fetch is authoritative: streamed chunks can be partial, and a
        // reconnect can have dropped some entirely.
        try {
          const job = await service.getJob(jobId);
          patchItem(id, (prev) => ({
            status: 'completed',
            job,
            text: job.resultText?.trim() || prev.text,
          }));
        } catch {
          // The transcript we streamed is still worth keeping — completion is
          // not downgraded to a failure just because the read-back failed.
          patchItem(id, { status: 'completed' });
        }
        if (onJobCompletedRef.current) {
          setItems((prev) => {
            const item = prev.find((i) => i.id === id);
            if (item) onJobCompletedRef.current?.(item);
            return prev;
          });
        }
      };

      const fail = (message: string) => {
        teardown(id);
        failItem(id, new Error(message));
      };

      sse.onEvent('chunk', appendSegment);
      sse.onEvent('complete', () => {
        void finish();
      });
      sse.onEvent('status', (raw) => {
        const status = parseStatus(raw);
        if (status === 'COMPLETED') void finish();
        else if (status === 'FAILED') fail('Transcription job failed');
      });
      sse.onEvent('error', (raw) => {
        fail(parseMessage(raw) ?? 'Transcription job failed');
      });
      // Unnamed frames only (EventSource routes named events exclusively to
      // their own listeners), so this cannot double-handle the events above.
      sse.onMessage((raw) => {
        const status = parseStatus(raw);
        if (status === 'COMPLETED') void finish();
        else if (status === 'FAILED') fail('Transcription job failed');
        else appendSegment(raw);
      });
      // Reconnection is handled inside SSEClient; a transport blip is not a
      // job failure and must not mark the item failed here.
      sse.onError(() => {});

      sse.connect(service.buildJobStreamUrl(jobId), { autoReconnect: true, maxReconnectAttempts: 10 });
    },
    [failItem, patchItem, teardown],
  );

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------
  const runItem = useCallback(
    async (id: string) => {
      const runtime = runtimeRef.current.get(id);
      if (!runtime) return;

      const client = apiClientRef.current;
      if (!client) {
        failItem(id, new Error('SDK not initialized — no apiClient available. Mount <ArcaCompatProvider> before uploading.'), 'configuration');
        return;
      }
      const pipelineId = runtime.options.pipelineId?.trim();
      if (!pipelineId) {
        failItem(
          id,
          new Error('No pipelineId available for this upload. Pass one via enqueue(files, { pipelineId }) or the hook options.'),
          'configuration',
        );
        return;
      }

      const service = new FileTranscriptionService(client, loggerRef.current ?? undefined);
      const abort = new AbortController();
      runtime.service = service;
      runtime.abort = abort;

      patchItem(id, { status: 'uploading', uploadProgress: 0, error: null });

      let job: TranscriptionJobResponse;
      try {
        job = await service.uploadAndTranscribeWithProgress(runtime.file, {
          pipelineId,
          ...(runtime.options.language ? { language: runtime.options.language } : {}),
          ...(runtime.options.consultationId ? { consultationId: runtime.options.consultationId } : {}),
          signal: abort.signal,
          onProgress: (progress) => patchItem(id, { uploadProgress: Math.round(progress) }),
        });
      } catch (err) {
        runtime.abort = null;
        if (cancelledRef.current.has(id) || abort.signal.aborted) {
          patchItem(id, { status: 'cancelled', uploadProgress: 0 });
          return;
        }
        failItem(id, err, 'network');
        return;
      }

      runtime.abort = null;
      if (cancelledRef.current.has(id)) {
        // Cancelled while the upload was in flight — the job exists on the
        // backend, so cancel it there too rather than leaking a queued job.
        service.cancelJob(job.id).catch(() => {});
        patchItem(id, { status: 'cancelled', jobId: job.id });
        return;
      }

      patchItem(id, { status: 'processing', uploadProgress: 100, jobId: job.id, job });
      connectStream(id, job.id, service);
    },
    [connectStream, failItem, patchItem],
  );

  // ---------------------------------------------------------------------------
  // Scheduler — starts pending items while a slot is free.
  //
  // A slot is held for the WHOLE lifecycle (upload AND stream), not just the
  // upload: the cap exists to bound concurrent sockets and backend load, and an
  // upload-only cap would leave N streams open regardless.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const active = items.filter((item) => ACTIVE_STATUSES.includes(item.status)).length;
    let free = Math.max(0, concurrency - active);
    if (free === 0) return;
    for (const item of items) {
      if (free === 0) break;
      if (item.status !== 'pending' || startedRef.current.has(item.id)) continue;
      startedRef.current.add(item.id);
      free -= 1;
      void runItem(item.id);
    }
  }, [items, concurrency, runItem]);

  useEffect(() => {
    unmountedRef.current = false;
    const runtimes = runtimeRef.current;
    return () => {
      unmountedRef.current = true;
      for (const [, runtime] of runtimes) {
        runtime.abort?.abort();
        runtime.sse?.disconnect();
        runtime.service?.dispose();
      }
      runtimes.clear();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Public queue operations
  // ---------------------------------------------------------------------------
  const enqueue = useCallback((files: File[] | FileList, options?: BatchTranscriptionOptions): string[] => {
    const list = Array.from(files as ArrayLike<File>);
    if (list.length === 0) return [];

    const created: BatchQueueItem[] = [];
    for (const file of list) {
      idCounterRef.current += 1;
      const id = `batch-item-${idCounterRef.current}`;
      // Options are SNAPSHOT here, not read at run time: a queue that changes
      // pipeline halfway because the picker moved would be untraceable.
      runtimeRef.current.set(id, {
        file,
        options: { ...defaultOptionsRef.current, ...options },
        service: null,
        abort: null,
        sse: null,
      });
      created.push({
        id,
        fileName: file.name,
        size: file.size,
        status: 'pending',
        uploadProgress: 0,
        jobId: null,
        segments: [],
        text: '',
        error: null,
        job: null,
      });
    }
    setItems((prev) => [...prev, ...created]);
    return created.map((item) => item.id);
  }, []);

  const cancel = useCallback(
    (itemId: string) => {
      const runtime = runtimeRef.current.get(itemId);
      if (!runtime) return;
      cancelledRef.current.add(itemId);

      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== itemId) return item;
          if (item.status === 'completed' || item.status === 'cancelled') return item;
          if (item.jobId) runtime.service?.cancelJob(item.jobId).catch(() => {});
          return { ...item, status: 'cancelled' };
        }),
      );
      teardown(itemId, { abortUpload: true });
    },
    [teardown],
  );

  const retry = useCallback(
    (itemId: string) => {
      const runtime = runtimeRef.current.get(itemId);
      if (!runtime) return;
      cancelledRef.current.delete(itemId);
      startedRef.current.delete(itemId);
      teardown(itemId, { abortUpload: true });
      patchItem(itemId, { status: 'pending', uploadProgress: 0, jobId: null, segments: [], text: '', error: null, job: null });
    },
    [patchItem, teardown],
  );

  const remove = useCallback(
    (itemId: string) => {
      teardown(itemId, { abortUpload: true });
      runtimeRef.current.get(itemId)?.service?.dispose();
      runtimeRef.current.delete(itemId);
      startedRef.current.delete(itemId);
      cancelledRef.current.delete(itemId);
      setItems((prev) => prev.filter((item) => item.id !== itemId));
    },
    [teardown],
  );

  const clear = useCallback(() => {
    for (const id of Array.from(runtimeRef.current.keys())) {
      teardown(id, { abortUpload: true });
      runtimeRef.current.get(id)?.service?.dispose();
    }
    runtimeRef.current.clear();
    startedRef.current.clear();
    cancelledRef.current.clear();
    setItems([]);
  }, [teardown]);

  const activeCount = useMemo(() => items.filter((item) => ACTIVE_STATUSES.includes(item.status)).length, [items]);

  return {
    items,
    enqueue,
    cancel,
    retry,
    remove,
    clear,
    isUploading: items.some((item) => item.status === 'uploading'),
    isStreaming: items.some((item) => item.status === 'processing'),
    activeCount,
    error,
  };
}
