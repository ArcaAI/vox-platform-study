'use client';

/**
 * @arcaai/vox - BatchTranscriptionQueue
 *
 * The native batch-transcription engine: upload N pre-recorded files, monitor
 * each job, collect each result. Framework-free on purpose — React owns
 * rendering, this owns the caps, the scheduling and the transport, and both are
 * testable without the other. `useBatchTranscription` is a thin subscriber.
 *
 * ── THE CAPS ────────────────────────────────────────────────────────────────
 * "Up to 5 recordings, each at most 60 minutes" is enforced HERE as well as on
 * the gateway, for different reasons: the gateway is authoritative (a client
 * can be bypassed), while this copy exists so the user is told immediately
 * rather than after pushing ~115 MB that was never going to be accepted. The
 * numbers are not hardcoded twice — `setLimits()` takes the gateway's own
 * `GET /audio/transcription-jobs/limits` response, so an operator who lowers a
 * knob moves both sides at once. The values below are only the fallback for a
 * client that has not fetched them yet.
 *
 * A rejected file becomes a `failed` row carrying a `rejectionReason`, never a
 * silent drop: a user who selects six files must SEE which one was refused.
 *
 * ── TWO TRANSPORT DETAILS THAT FAIL SILENTLY IF WRONG ───────────────────────
 *  1. `new SSEClient(scope, apiClient, logger)` — the 3-argument form. The
 *     legacy 1-arg form is blocked inside `openWithTicket` and yields a
 *     permanent connection failure with no error on the happy path.
 *  2. The ticket scope is PER JOB — `transcription_job:<jobId>`. The route
 *     declares `@StreamScope({ namespace: 'transcription_job', param: 'id' })`
 *     and the guard compares it for equality; any other scope string is a 401.
 *
 * Both are locked by `__tests__/BatchTranscriptionQueue.test.ts`.
 */

import type { AgenticClient } from './AgenticClient';
import { FileTranscriptionService } from './FileTranscriptionService';
import { SSEClient, type SSEApiClient } from './SSEClient';
import { probeAudioDurationSeconds } from './audioDuration';
import { transcriptionJobScopeFor } from './constants';
import type { ISDKLogger } from './logger';
import type { TranscriptionJobResponse } from '../types/stt';

/** Lifecycle of one queued recording. */
export type BatchItemStatus = 'validating' | 'pending' | 'uploading' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** Why a file was refused before it was ever uploaded. */
export type BatchRejectionReason = 'too_many' | 'too_long' | 'too_large' | 'unsupported_type';

/** One transcript segment streamed back for a job. */
export interface BatchTranscriptSegment {
  text: string;
  isFinal: boolean;
  startTime?: number;
  endTime?: number;
  speakerId?: string;
  speakerLabel?: string;
}

/** One row of the queue. The underlying `File` is held internally for retry. */
export interface BatchQueueItem {
  /** Stable client-side id. NOT the job id — that exists only after upload. */
  id: string;
  fileName: string;
  /** File size in bytes. */
  size: number;
  status: BatchItemStatus;
  /** 0–100, upload only. Backend progress arrives via `job.progress`. */
  uploadProgress: number;
  /** Backend job id, once the upload returned one. */
  jobId: string | null;
  /** Locally probed duration in seconds; `null` when the browser could not read it. */
  durationSeconds: number | null;
  /** Set when a cap refused this file, so the UI can explain WHICH rule bit. */
  rejectionReason: BatchRejectionReason | null;
  /** Segments streamed so far, in arrival order. */
  segments: BatchTranscriptSegment[];
  /**
   * Transcript text. While streaming this is the joined FINAL segments; once the
   * job completes it is the job's own `resultText` — authoritative, because
   * streamed chunks can be partial or dropped across a reconnect.
   */
  text: string;
  error: string | null;
  /** Last job payload seen (upload response, then the terminal read-back). */
  job: TranscriptionJobResponse | null;
}

/** Per-upload options. Given as queue defaults and/or per `enqueue`. */
export interface BatchTranscriptionOptions {
  /** ASR pipeline id. Required — from the per-enqueue value, else the queue default. */
  pipelineId?: string;
  /** ISO 639-1 code, or a language-mode id the pipeline understands. */
  language?: string;
  /** Optional consultation to link every job to. */
  consultationId?: string;
}

/** The ceilings a client enforces locally. Mirrors the gateway's `/limits`. */
export interface BatchTranscriptionLimits {
  maxFilesPerBatch: number;
  maxDurationMinutes: number;
  maxFileSizeBytes: number;
  allowedMimeTypes?: string[];
}

export interface BatchTranscriptionQueueConfig {
  apiClient: AgenticClient;
  logger?: ISDKLogger;
  /** Defaults applied to every `enqueue` that does not override them. */
  options?: BatchTranscriptionOptions;
  /** Client-side ceilings. Replaced by the gateway's values via `setLimits()`. */
  limits?: Partial<BatchTranscriptionLimits>;
  /**
   * Files in flight at once, counting BOTH the upload and the result stream.
   * Default 2 — a 5-file batch must not open 5 sockets at once.
   */
  concurrency?: number;
  onItemCompleted?: (item: BatchQueueItem) => void;
  onError?: (error: Error, itemId: string) => void;
}

/**
 * Fallback ceilings, used only until the gateway's `/limits` response arrives.
 * They match the platform code defaults (`stt.batch.*`), so an SDK that never
 * fetches limits still enforces the documented contract.
 */
export const DEFAULT_BATCH_LIMITS: BatchTranscriptionLimits = {
  maxFilesPerBatch: 5,
  maxDurationMinutes: 60,
  maxFileSizeBytes: 250 * 1024 * 1024,
};

const DEFAULT_CONCURRENCY = 2;

/** Statuses that hold a concurrency slot. */
const ACTIVE_STATUSES: BatchItemStatus[] = ['validating', 'uploading', 'processing'];
/** Statuses that count against `maxFilesPerBatch` (a removed row frees its place). */
const COUNTED_STATUSES: BatchItemStatus[] = ['validating', 'pending', 'uploading', 'processing', 'completed'];

interface ItemRuntime {
  file: File;
  options: BatchTranscriptionOptions;
  service: FileTranscriptionService | null;
  abort: AbortController | null;
  sse: SSEClient | null;
  cancelled: boolean;
  started: boolean;
}

export class BatchTranscriptionQueue {
  private items: BatchQueueItem[] = [];
  private readonly runtimes = new Map<string, ItemRuntime>();
  private readonly listeners = new Set<() => void>();
  private limits: BatchTranscriptionLimits;
  private defaults: BatchTranscriptionOptions;
  private idCounter = 0;
  private disposed = false;

  constructor(private readonly config: BatchTranscriptionQueueConfig) {
    this.limits = { ...DEFAULT_BATCH_LIMITS, ...config.limits };
    this.defaults = { ...config.options };
  }

  // ── read surface ──────────────────────────────────────────────────────────

  /**
   * Current rows. The array identity is STABLE between changes so
   * `useSyncExternalStore` does not re-render on every tick.
   */
  getSnapshot(): BatchQueueItem[] {
    return this.items;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLimits(): BatchTranscriptionLimits {
    return this.limits;
  }

  /** Adopt the gateway's resolved ceilings (from `GET .../limits`). */
  setLimits(limits: Partial<BatchTranscriptionLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  /** Replace the per-upload defaults applied to later `enqueue` calls. */
  setDefaults(options: BatchTranscriptionOptions): void {
    this.defaults = { ...options };
  }

  // ── queue operations ──────────────────────────────────────────────────────

  /**
   * Append files. Returns the new row ids IN ORDER — including rows that were
   * refused, which land as `failed` with a `rejectionReason` so the caller can
   * show exactly what happened to each selected file.
   */
  enqueue(files: File[] | FileList, options?: BatchTranscriptionOptions): string[] {
    const list = Array.from(files as ArrayLike<File>);
    if (list.length === 0) return [];

    const created: BatchQueueItem[] = [];
    // Counted against rows that ALREADY exist, so three drops of two files are
    // one batch of six rather than three batches of two.
    let room = this.limits.maxFilesPerBatch - this.countTowardBatch();

    for (const file of list) {
      const id = `batch-item-${(this.idCounter += 1)}`;
      this.runtimes.set(id, {
        file,
        // Options are SNAPSHOT at enqueue: a queue whose pipeline changed
        // halfway because a picker moved would be untraceable afterwards.
        options: { ...this.defaults, ...options },
        service: null,
        abort: null,
        sse: null,
        cancelled: false,
        started: false,
      });

      const base: BatchQueueItem = {
        id,
        fileName: file.name,
        size: file.size,
        status: 'validating',
        uploadProgress: 0,
        jobId: null,
        durationSeconds: null,
        rejectionReason: null,
        segments: [],
        text: '',
        error: null,
        job: null,
      };

      const reason = this.staticRejection(file, room);
      if (reason) {
        created.push({ ...base, status: 'failed', rejectionReason: reason, error: this.rejectionMessage(reason, file) });
      } else {
        room -= 1;
        created.push(base);
      }
    }

    this.items = [...this.items, ...created];
    this.notify();

    // Duration probing is async; the scheduler only starts an item once it has
    // passed. Nothing is uploaded from inside `enqueue`.
    for (const item of created) {
      if (item.status !== 'failed') void this.validateDuration(item.id);
    }
    return created.map((i) => i.id);
  }

  /** Abort the upload, or cancel the backend job and drop its stream. */
  cancel(itemId: string): void {
    const runtime = this.runtimes.get(itemId);
    const item = this.items.find((i) => i.id === itemId);
    if (!runtime || !item) return;
    if (item.status === 'completed' || item.status === 'cancelled') return;

    runtime.cancelled = true;
    // A job that exists on the backend must be cancelled THERE too, or the
    // worker keeps transcribing something nobody is listening to.
    if (item.jobId) runtime.service?.cancelJob(item.jobId).catch(() => {});
    this.teardown(itemId, { abortUpload: true });
    this.patch(itemId, { status: 'cancelled' });
  }

  /** Re-run a failed/cancelled item from the top. */
  retry(itemId: string): void {
    const runtime = this.runtimes.get(itemId);
    if (!runtime) return;
    runtime.cancelled = false;
    runtime.started = false;
    this.teardown(itemId, { abortUpload: true });
    this.patch(itemId, {
      status: 'validating',
      uploadProgress: 0,
      jobId: null,
      durationSeconds: null,
      rejectionReason: null,
      segments: [],
      text: '',
      error: null,
      job: null,
    });
    void this.validateDuration(itemId);
  }

  /** Drop one row, stopping it first. Frees its place in the batch. */
  remove(itemId: string): void {
    this.stopItem(itemId);
    this.runtimes.delete(itemId);
    this.items = this.items.filter((i) => i.id !== itemId);
    this.notify();
    this.schedule();
  }

  /** Drop every row, stopping each first. */
  clear(): void {
    for (const id of [...this.runtimes.keys()]) this.stopItem(id);
    this.runtimes.clear();
    this.items = [];
    this.notify();
  }

  /** Release every transport handle. The queue is unusable afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.runtimes.keys()]) this.stopItem(id);
    this.runtimes.clear();
    this.listeners.clear();
  }

  // ── validation ────────────────────────────────────────────────────────────

  /** Checks decidable without reading the file. `null` = accepted so far. */
  private staticRejection(file: File, room: number): BatchRejectionReason | null {
    if (room <= 0) return 'too_many';
    if (file.size > this.limits.maxFileSizeBytes) return 'too_large';
    const allowed = this.limits.allowedMimeTypes;
    // An empty `type` is common for files dragged from disk — the gateway
    // sniffs the bytes, so an unknown type is not refused here.
    if (allowed && allowed.length > 0 && file.type && !allowed.includes(file.type)) return 'unsupported_type';
    return null;
  }

  private rejectionMessage(reason: BatchRejectionReason, file: File): string {
    switch (reason) {
      case 'too_many':
        return `Only ${this.limits.maxFilesPerBatch} recordings can be uploaded at a time.`;
      case 'too_long':
        return `Recording is longer than the ${this.limits.maxDurationMinutes}-minute maximum.`;
      case 'too_large':
        return `File is larger than the ${Math.round(this.limits.maxFileSizeBytes / (1024 * 1024))} MB maximum.`;
      case 'unsupported_type':
        return `${file.type || 'This file type'} is not a supported audio format.`;
    }
  }

  /**
   * Probe the duration locally, then admit or refuse the item.
   *
   * An UNREADABLE duration is admitted — unlike the gateway, which fails closed.
   * The asymmetry is deliberate: the browser cannot decode every container it
   * may legitimately be handed, so refusing here would block uploads the server
   * would have accepted, and the server still gets the final say.
   */
  private async validateDuration(itemId: string): Promise<void> {
    const runtime = this.runtimes.get(itemId);
    if (!runtime) return;

    const seconds = await probeAudioDurationSeconds(runtime.file);
    if (this.disposed || !this.runtimes.has(itemId) || runtime.cancelled) return;

    if (seconds !== null && seconds > this.limits.maxDurationMinutes * 60) {
      this.patch(itemId, {
        status: 'failed',
        durationSeconds: seconds,
        rejectionReason: 'too_long',
        error: this.rejectionMessage('too_long', runtime.file),
      });
      this.schedule();
      return;
    }

    this.patch(itemId, { status: 'pending', durationSeconds: seconds });
    this.schedule();
  }

  // ── scheduling ────────────────────────────────────────────────────────────

  /**
   * Start pending items while a slot is free. A slot is held for the WHOLE
   * lifecycle (upload AND stream), not just the upload — the cap exists to
   * bound open sockets and backend load, and an upload-only cap would leave
   * every stream open regardless.
   */
  private schedule(): void {
    if (this.disposed) return;
    const concurrency = this.config.concurrency ?? DEFAULT_CONCURRENCY;
    let free = concurrency - this.items.filter((i) => ACTIVE_STATUSES.includes(i.status)).length;

    for (const item of this.items) {
      if (free <= 0) break;
      const runtime = this.runtimes.get(item.id);
      if (item.status !== 'pending' || !runtime || runtime.started) continue;
      runtime.started = true;
      free -= 1;
      void this.runItem(item.id);
    }
  }

  private async runItem(itemId: string): Promise<void> {
    const runtime = this.runtimes.get(itemId);
    if (!runtime) return;

    const pipelineId = runtime.options.pipelineId?.trim();
    if (!pipelineId) {
      this.failItem(itemId, new Error('No pipelineId for this upload. Pass one to enqueue(files, { pipelineId }) or in the queue options.'));
      return;
    }

    const service = new FileTranscriptionService(this.config.apiClient, this.config.logger);
    const abort = new AbortController();
    runtime.service = service;
    runtime.abort = abort;
    this.patch(itemId, { status: 'uploading', uploadProgress: 0, error: null });

    let job: TranscriptionJobResponse;
    try {
      job = await service.uploadAndTranscribeWithProgress(runtime.file, {
        pipelineId,
        ...(runtime.options.language ? { language: runtime.options.language } : {}),
        ...(runtime.options.consultationId ? { consultationId: runtime.options.consultationId } : {}),
        signal: abort.signal,
        onProgress: (progress) => this.patch(itemId, { uploadProgress: Math.round(progress) }),
      });
    } catch (err) {
      runtime.abort = null;
      if (runtime.cancelled || abort.signal.aborted) {
        this.patch(itemId, { status: 'cancelled', uploadProgress: 0 });
      } else {
        this.failItem(itemId, err);
      }
      this.schedule();
      return;
    }

    runtime.abort = null;
    if (runtime.cancelled) {
      // Cancelled mid-upload: the job now exists server-side, so cancel it
      // there rather than leaking a queued job nobody will read.
      service.cancelJob(job.id).catch(() => {});
      this.patch(itemId, { status: 'cancelled', jobId: job.id });
      this.schedule();
      return;
    }

    this.patch(itemId, { status: 'processing', uploadProgress: 100, jobId: job.id, job });
    this.connectStream(itemId, job.id, service);
  }

  // ── result stream ─────────────────────────────────────────────────────────

  private connectStream(itemId: string, jobId: string, service: FileTranscriptionService): void {
    const runtime = this.runtimes.get(itemId);
    if (!runtime) return;

    // 3-arg form + per-job scope. See the file header: either one wrong is a
    // stream that connects to nothing and never reports why.
    const sse = new SSEClient(transcriptionJobScopeFor(jobId), this.config.apiClient as unknown as SSEApiClient, this.config.logger);
    runtime.sse = sse;

    const appendSegment = (raw: string) => {
      const segment = parseSegment(raw);
      if (!segment) return;
      this.patch(itemId, (prev) => {
        const segments = [...prev.segments, segment];
        return { segments, text: joinFinals(segments) };
      });
    };

    const finish = async () => {
      this.teardown(itemId);
      try {
        // Authoritative: streamed chunks can be partial, and a reconnect can
        // have dropped some entirely.
        const finalJob = await service.getJob(jobId);
        this.patch(itemId, (prev) => ({ status: 'completed', job: finalJob, text: finalJob.resultText?.trim() || prev.text }));
      } catch {
        // A failed read-back does not downgrade a completed job — the streamed
        // transcript is still the user's result.
        this.patch(itemId, { status: 'completed' });
      }
      const item = this.items.find((i) => i.id === itemId);
      if (item) this.config.onItemCompleted?.(item);
      this.schedule();
    };

    const fail = (message: string) => {
      this.teardown(itemId);
      this.failItem(itemId, new Error(message));
      this.schedule();
    };

    sse.onEvent('chunk', appendSegment);
    sse.onEvent('complete', () => void finish());
    sse.onEvent('status', (raw) => {
      const status = parseStatus(raw);
      if (status === 'COMPLETED') void finish();
      else if (status === 'FAILED') fail('Transcription job failed');
    });
    sse.onEvent('error', (raw) => fail(parseMessage(raw) ?? 'Transcription job failed'));
    // Unnamed frames only — EventSource routes named events exclusively to
    // their own listeners, so this cannot double-handle the ones above.
    sse.onMessage((raw) => {
      const status = parseStatus(raw);
      if (status === 'COMPLETED') void finish();
      else if (status === 'FAILED') fail('Transcription job failed');
      else appendSegment(raw);
    });
    // Reconnection is SSEClient's job; a transport blip is not a job failure.
    sse.onError(() => {});

    sse.connect(service.buildJobStreamUrl(jobId), { autoReconnect: true, maxReconnectAttempts: 10 });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private countTowardBatch(): number {
    return this.items.filter((i) => COUNTED_STATUSES.includes(i.status)).length;
  }

  private failItem(itemId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.patch(itemId, { status: 'failed', error: message });
    this.config.onError?.(err instanceof Error ? err : new Error(message), itemId);
  }

  /** Release an item's transport handles without touching its row. */
  private teardown(itemId: string, opts: { abortUpload?: boolean } = {}): void {
    const runtime = this.runtimes.get(itemId);
    if (!runtime) return;
    if (opts.abortUpload) runtime.abort?.abort();
    runtime.abort = null;
    runtime.sse?.disconnect();
    runtime.sse = null;
  }

  private stopItem(itemId: string): void {
    this.teardown(itemId, { abortUpload: true });
    this.runtimes.get(itemId)?.service?.dispose();
  }

  private patch(itemId: string, patch: Partial<BatchQueueItem> | ((prev: BatchQueueItem) => Partial<BatchQueueItem>)): void {
    if (this.disposed) return;
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id !== itemId) return item;
      changed = true;
      return { ...item, ...(typeof patch === 'function' ? patch(item) : patch) };
    });
    if (changed) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

// ── payload parsing ─────────────────────────────────────────────────────────
// The job stream carries named events (`chunk`/`status`/`complete`/`error`)
// whose payload is bare, while a generic `message` frame nests the same body
// under `data`. Both shapes are accepted rather than guessed at.

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function unwrap(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return ((parsed.data as Record<string, unknown>) ?? parsed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseSegment(raw: string): BatchTranscriptSegment | null {
  const payload = unwrap(raw);
  if (!payload) return null;
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

function parseStatus(raw: string): string | null {
  const payload = unwrap(raw);
  const status = payload?.status;
  return typeof status === 'string' ? status.toUpperCase() : null;
}

function parseMessage(raw: string): string | null {
  const payload = unwrap(raw);
  return typeof payload?.message === 'string' ? payload.message : null;
}

/** Join the FINAL segments — interim ones are hypotheses, not transcript. */
function joinFinals(segments: BatchTranscriptSegment[]): string {
  return segments
    .filter((s) => s.isFinal)
    .map((s) => s.text)
    .join(' ')
    .trim();
}
