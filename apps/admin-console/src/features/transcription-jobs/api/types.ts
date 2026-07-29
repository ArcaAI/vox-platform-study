export type TranscriptionJobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DEAD';

export type TranscriptionJobType = 'BATCH' | 'STREAMING';

/** Job states after which the row can no longer change (stop polling). */
export const TERMINAL_JOB_STATUSES: readonly TranscriptionJobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'];

/**
 * GET /admin/audio/transcription-jobs rows (TranscriptionJobResponse).
 * Timestamps are ISO strings on the wire.
 */
export interface TranscriptionJob {
  id: string;
  jobType: TranscriptionJobType;
  pipelineId: string;
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
