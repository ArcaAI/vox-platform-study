export type TranscriptionJobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DEAD';

export type TranscriptionJobType = 'BATCH' | 'STREAMING';

/** Job states after which the row can no longer change (stop polling). */
export const TERMINAL_JOB_STATUSES: readonly TranscriptionJobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'];

/**
 * TASK-999 C-2 — the fallback-chain entry that actually served the job,
 * written at completion/teardown. `chainIndex` points into
 * `resolvedSpec.fallback.chain`; `-1` means the serving engine could not be
 * matched to a chain entry (render an explanation, never guess).
 */
export interface ServedBy {
  chainIndex: number;
  source: 'primary' | 'fallback';
  agentSlug: string | null;
  modelSlug: string | null;
  provider: string | null;
  engine: string | null;
}

/**
 * GET /admin/audio/transcription-jobs rows (TranscriptionJobResponse).
 * Timestamps are ISO strings on the wire.
 */
export interface TranscriptionJob {
  id: string;
  jobType: TranscriptionJobType;
  /** TASK-861 — the ASR Agent VERSION that ran the job (rows are versions). */
  agentVersionId?: string | null;
  /** TASK-861 — the `ResolvedAsrSpec` snapshot the job ran on (never a credential). */
  resolvedSpec?: unknown;
  consultationId?: string | null;
  contextItemId?: string | null;
  mediaId?: string | null;
  status: TranscriptionJobStatus;
  /** 0-100. */
  progress: number;
  queuedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  resultText?: string | null;
  resultMetadata?: unknown;
  errorMessage?: string | null;
  errorCode?: string | null;
  retryCount: number;
  maxRetries: number;
  workerId?: string | null;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  /** TASK-999 C-2 — realtime sessions persisted as `jobType = STREAMING` rows; `null` for a BATCH job. */
  streamSessionId?: string | null;
  /** TASK-999 C-2 — the fallback-chain entry that served; `null` when not recorded. */
  servedBy?: ServedBy | null;
  /** TASK-999 C-2 — `null` = never measured; `0` is a real empty transcript. */
  resultWordCount?: number | null;
  resultCharCount?: number | null;
  /** TASK-999 C-2 — `completedAt - startedAt`; `null` while the job is still running. */
  durationMs?: number | null;
}

/**
 * List envelope (PaginatedTranscriptionJobResponse) — CUSTOM:
 * `total`/`totalPages` and a 1-BASED `page`, not the platform Paginated shape.
 */
export interface PaginatedTranscriptionJobs {
  data: TranscriptionJob[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** GET /admin/audio/transcription-jobs/stats (TranscriptionJobStatusCountResponse). */
export interface TranscriptionJobStats {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  dead: number;
}
