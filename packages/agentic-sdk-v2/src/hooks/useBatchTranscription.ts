'use client';

/**
 * @arcaai/vox - useBatchTranscription
 *
 * The native batch-transcription surface: upload up to 5 recordings of at most
 * 60 minutes each, monitor each job, collect each result.
 *
 * ```tsx
 * const batch = useBatchTranscription({ options: { pipelineId } });
 * <input type="file" multiple accept="audio/*"
 *        onChange={(e) => batch.enqueue(e.target.files ?? [])} />
 * {batch.items.map((item) => (
 *   <li key={item.id}>{item.fileName} — {item.status} {item.text}</li>
 * ))}
 * ```
 *
 * The hook is a thin React seam over `BatchTranscriptionQueue`, which owns the
 * caps, the scheduling and the transport. Two things happen here and nowhere
 * else:
 *
 *  1. **The gateway's ceilings win.** `GET /audio/transcription-jobs/limits`
 *     returns the admin-configured `stt.batch.*` values and they replace the
 *     built-in defaults, so "5 recordings / 60 minutes" is not hardcoded on both
 *     sides of the wire. A failed fetch leaves the documented defaults in force
 *     — the gateway re-checks every upload anyway, so a limits hiccup must not
 *     block uploading.
 *  2. **The queue outlives renders.** It is created once per provider client and
 *     disposed on unmount, so an in-flight upload and its result stream survive
 *     a re-render but never outlive the screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  BatchTranscriptionQueue,
  DEFAULT_BATCH_LIMITS,
  type BatchQueueItem,
  type BatchTranscriptionLimits,
  type BatchTranscriptionOptions,
} from '../core/BatchTranscriptionQueue';
import { STT_ENDPOINTS } from '../core/constants';
import { useAgenticStore } from '../store';

/** The gateway's `GET .../limits` payload. */
export interface BatchTranscriptionLimitsResponse {
  maxFilesPerBatch?: number;
  maxDurationMinutes?: number;
  maxFileSizeBytes?: number;
  maxActiveJobsPerUser?: number;
  allowedMimeTypes?: string[];
}

export interface UseBatchTranscriptionProps {
  /** Defaults applied to every `enqueue` that does not override them. */
  options?: BatchTranscriptionOptions;
  /** Files in flight at once (upload AND stream). Default 2. */
  concurrency?: number;
  onItemCompleted?: (item: BatchQueueItem) => void;
  onError?: (error: Error, itemId: string) => void;
}

export interface UseBatchTranscriptionReturn {
  /** One row per selected file, in selection order. */
  items: BatchQueueItem[];
  /** Append files. Returns the new row ids — including refused ones, which land as `failed`. */
  enqueue: (files: File[] | FileList, options?: BatchTranscriptionOptions) => string[];
  /** Abort the upload, or cancel the backend job and drop its stream. */
  cancel: (itemId: string) => void;
  /** Re-run a failed/cancelled row from the top. */
  retry: (itemId: string) => void;
  /** Drop one row (stopping it first). Frees its place in the batch. */
  remove: (itemId: string) => void;
  /** Drop every row (stopping each first). */
  clear: () => void;
  /** Effective ceilings — the gateway's once loaded, the defaults until then. */
  limits: BatchTranscriptionLimits;
  /** Set when the limits fetch failed; the defaults remain in force. */
  limitsError: Error | null;
  /** How many more recordings this batch will accept. */
  remainingSlots: number;
  isUploading: boolean;
  isProcessing: boolean;
  /** Rows holding a concurrency slot (uploading or processing). */
  activeCount: number;
}

/** Rows that occupy a place in the batch (a removed/cancelled row frees its slot). */
const COUNTED: BatchQueueItem['status'][] = ['validating', 'pending', 'uploading', 'processing', 'completed'];

export function useBatchTranscription(props: UseBatchTranscriptionProps = {}): UseBatchTranscriptionReturn {
  const store = useAgenticStore();
  const apiClient = store.apiClient;
  const logger = useMemo(() => store.logger?.child('useBatchTranscription'), [store.logger]);

  const [limitsError, setLimitsError] = useState<Error | null>(null);
  // Mirrored in React state rather than read from the queue during render: the
  // external store publishes ROW changes, so a limits update alone would not
  // re-render and the UI would keep showing the default ceilings.
  const [limits, setLimits] = useState<BatchTranscriptionLimits>(DEFAULT_BATCH_LIMITS);

  // Callbacks are read through refs so a new inline function on every render
  // does not force a queue rebuild (which would drop in-flight uploads).
  const onItemCompletedRef = useRef(props.onItemCompleted);
  onItemCompletedRef.current = props.onItemCompleted;
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;
  const concurrencyRef = useRef(props.concurrency);
  concurrencyRef.current = props.concurrency;

  // One queue per API client. `useMemo` (not `useState`) so a client swap —
  // tenant switch, re-auth — rebuilds it rather than uploading to the old one.
  const queue = useMemo(() => {
    if (!apiClient) return null;
    return new BatchTranscriptionQueue({
      apiClient,
      logger,
      get concurrency() {
        return concurrencyRef.current;
      },
      onItemCompleted: (item) => onItemCompletedRef.current?.(item),
      onError: (err, itemId) => onErrorRef.current?.(err, itemId),
    });
  }, [apiClient, logger]);

  useEffect(() => () => queue?.dispose(), [queue]);

  // A rebuilt queue (client swap) starts from the defaults again until its own
  // limits fetch lands.
  useEffect(() => setLimits(queue?.getLimits() ?? DEFAULT_BATCH_LIMITS), [queue]);

  // Upload defaults can change with the UI (a pipeline picker) — push them into
  // the live queue instead of rebuilding it.
  const optionsKey = JSON.stringify(props.options ?? {});
  useEffect(() => {
    queue?.setDefaults(JSON.parse(optionsKey) as BatchTranscriptionOptions);
  }, [queue, optionsKey]);

  // The gateway's ceilings replace the defaults; a failure leaves them in force.
  useEffect(() => {
    if (!queue || !apiClient) return;
    let cancelled = false;

    apiClient
      .get<BatchTranscriptionLimitsResponse>(STT_ENDPOINTS.BATCH_LIMITS)
      .then((data) => {
        if (cancelled) return;
        const sanitized = sanitizeLimits(data);
        if (Object.keys(sanitized).length > 0) {
          queue.setLimits(sanitized);
          setLimits(queue.getLimits());
        }
        setLimitsError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        logger?.warn?.('Batch limits fetch failed; using SDK defaults', {
          operation: 'fetchLimits',
          component: 'useBatchTranscription',
          error: err,
        });
        setLimitsError(err);
      });

    return () => {
      cancelled = true;
    };
  }, [queue, apiClient, logger]);

  const items = useSyncExternalStore(
    useCallback((onChange: () => void) => queue?.subscribe(onChange) ?? (() => {}), [queue]),
    useCallback(() => queue?.getSnapshot() ?? EMPTY_ITEMS, [queue]),
    useCallback(() => queue?.getSnapshot() ?? EMPTY_ITEMS, [queue]),
  );

  const enqueue = useCallback((files: File[] | FileList, options?: BatchTranscriptionOptions) => queue?.enqueue(files, options) ?? [], [queue]);
  const cancel = useCallback((itemId: string) => queue?.cancel(itemId), [queue]);
  const retry = useCallback((itemId: string) => queue?.retry(itemId), [queue]);
  const remove = useCallback((itemId: string) => queue?.remove(itemId), [queue]);
  const clear = useCallback(() => queue?.clear(), [queue]);

  return useMemo(() => {
    const isUploading = items.some((i) => i.status === 'uploading');
    const isProcessing = items.some((i) => i.status === 'processing');
    const activeCount = items.filter((i) => i.status === 'uploading' || i.status === 'processing').length;
    const used = items.filter((i) => COUNTED.includes(i.status)).length;

    return {
      items,
      enqueue,
      cancel,
      retry,
      remove,
      clear,
      limits,
      limitsError,
      remainingSlots: Math.max(0, limits.maxFilesPerBatch - used),
      isUploading,
      isProcessing,
      activeCount,
    };
  }, [items, enqueue, cancel, retry, remove, clear, limits, limitsError]);
}

const EMPTY_ITEMS: BatchQueueItem[] = [];

/**
 * Keep only usable ceilings from the payload. A malformed or non-positive value
 * is DROPPED rather than adopted: a `maxFilesPerBatch` of `'five'` must not
 * become `NaN` and refuse every file.
 */
function sanitizeLimits(data: BatchTranscriptionLimitsResponse | null | undefined): Partial<BatchTranscriptionLimits> {
  const out: Partial<BatchTranscriptionLimits> = {};
  if (!data || typeof data !== 'object') return out;

  const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

  const files = positive(data.maxFilesPerBatch);
  if (files !== null) out.maxFilesPerBatch = files;
  const minutes = positive(data.maxDurationMinutes);
  if (minutes !== null) out.maxDurationMinutes = minutes;
  const bytes = positive(data.maxFileSizeBytes);
  if (bytes !== null) out.maxFileSizeBytes = bytes;
  if (Array.isArray(data.allowedMimeTypes) && data.allowedMimeTypes.every((t) => typeof t === 'string')) {
    out.allowedMimeTypes = data.allowedMimeTypes;
  }
  return out;
}
