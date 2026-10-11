import {
  BatchDispatchEnvelope,
  CreateJobInput,
  CreateBatchJobInput,
  CreateStreamingJobInput,
  TranscriptionJobResponse,
  PaginatedTranscriptionJobResponse,
  TranscriptionJobStatusCountResponse,
} from './dto';
import { TranscriptionJobStatus, TranscriptionJobType } from '@arcaai/domains';
import { JsonValue } from '@arcaai/domains';
import type { ServedBy } from '../served-by';

/**
 * TASK-999 (D-5(a)) — everything the streaming plane knows at session OPEN.
 *
 * `tenantId` is explicit rather than read from CLS: the streaming DTO carries it
 * (three teardown paths and one open path are tenant-less in CLS terms), and a
 * row written under the wrong tenant is a cross-tenant leak, not a cosmetic bug.
 */
export interface CreateStreamSessionJobInput {
  tenantId: string;
  /** The STT session id (`stt:session:{id}`) this row mirrors. */
  streamSessionId: string;
  consultationId?: string;
  /** `resolvedSpec.agent.versionId` — the ASR Agent version the session opened on. */
  agentVersionId?: string | null;
  resolvedSpec?: unknown;
  /** The clinician the session belongs to; becomes the row's `createdBy`. */
  userId?: string | null;
}

/** TASK-999 — what teardown knows. */
export interface CompleteStreamSessionJobInput {
  /**
   * The usage-ledger engine id that served LAST. A session can switch engines
   * mid-flight, so "what served" is the engine it ENDED on — the same engine the
   * teardown summary reports in its own scalar.
   */
  engine: string | null;
  /** `null`/absent = never measured. `0` would be a real empty transcript. */
  resultWordCount?: number | null;
  resultCharCount?: number | null;
}

/** TASK-999 — what the caller needs back to stamp its own usage rows. */
export interface CompletedStreamSessionJob {
  jobId: string;
  /** The row's own `resolvedSpec`, so per-segment models can be resolved from it. */
  resolvedSpec: JsonValue | null;
  servedBy: ServedBy | null;
  /** True when another teardown path had already closed this row; nothing was written. */
  alreadyCompleted: boolean;
}

export interface ITranscriptionJobService {
  /**
   * Create a transcription job keyed to the ASR agent the GATEWAY resolved (TASK-1012 L-7: never a
   * caller-supplied `agentVersionId` / `resolvedSpec`).
   */
  create(dto: CreateJobInput): Promise<TranscriptionJobResponse>;

  /**
   * Create a batch transcription job
   */
  createBatchJob(dto: CreateBatchJobInput): Promise<TranscriptionJobResponse>;

  /**
   * Create a streaming transcription job
   */
  createStreamingJob(dto: CreateStreamingJobInput): Promise<TranscriptionJobResponse>;

  /**
   * TASK-999 (D-5(a)) — write the row mirroring a realtime STT session, already
   * PROCESSING and with its `startedAt` stamped.
   */
  createForStreamSession(input: CreateStreamSessionJobInput): Promise<TranscriptionJobResponse>;

  /**
   * TASK-999 — close that row at teardown, recording which chain entry served.
   * `null` when no row exists for the session; `alreadyCompleted` when another
   * teardown path closed it first (nothing is written twice).
   */
  completeStreamSessionJob(streamSessionId: string, input: CompleteStreamSessionJobInput): Promise<CompletedStreamSessionJob | null>;

  /**
   * BUG-042 — close that row as FAILED (`STT_SESSION_GONE`) when the session ended without a
   * teardown summary. `null` when no row exists; `alreadyCompleted` when another path closed it.
   */
  failStreamSessionJob(streamSessionId: string, message: string): Promise<{ jobId: string; alreadyCompleted: boolean } | null>;

  /**
   * Get job by ID
   */
  getById(id: string): Promise<TranscriptionJobResponse | null>;

  /**
   * Get jobs by consultation (tenant-wide — admin surface)
   */
  getByConsultation(consultationId: string): Promise<TranscriptionJobResponse[]>;

  /**
   * EU-02 — owner-scoped variant of {@link getByConsultation}: only
   * the caller's OWN jobs (`createdBy`) for the consultation.
   */
  getByConsultationForOwner(ownerId: string, consultationId: string): Promise<TranscriptionJobResponse[]>;

  /**
   * Get paginated list of jobs (tenant-wide — admin surface)
   */
  list(page: number, limit: number, jobType?: TranscriptionJobType): Promise<PaginatedTranscriptionJobResponse>;

  /**
   * Owner-scoped paginated list (end-user surface): only the
   * jobs the given user created.
   */
  listForOwner(ownerId: string, page: number, limit: number): Promise<PaginatedTranscriptionJobResponse>;

  /**
   * Get jobs by status (tenant-wide — admin surface)
   */
  getByStatus(status: TranscriptionJobStatus): Promise<TranscriptionJobResponse[]>;

  /**
   * Owner-scoped variant of {@link getByStatus}.
   */
  getByStatusForOwner(ownerId: string, status: TranscriptionJobStatus): Promise<TranscriptionJobResponse[]>;

  /**
   * Get job status counts (tenant-wide — admin surface)
   */
  getStatusCounts(): Promise<TranscriptionJobStatusCountResponse>;

  /**
   * Owner-scoped variant of {@link getStatusCounts}.
   */
  getStatusCountsForOwner(ownerId: string): Promise<TranscriptionJobStatusCountResponse>;

  /**
   * Update job status (for internal use)
   */
  updateStatus(id: string, status: TranscriptionJobStatus, errorMessage?: string, errorCode?: string): Promise<TranscriptionJobResponse>;

  /**
   * Start processing a job (for internal use)
   */
  startProcessing(id: string, workerId: string): Promise<TranscriptionJobResponse>;

  /**
   * Update job progress (for internal use)
   */
  updateProgress(id: string, progress: number): Promise<TranscriptionJobResponse>;

  /**
   * Complete a job (for internal use)
   */
  completeJob(id: string, resultText: string, resultMetadata?: JsonValue): Promise<TranscriptionJobResponse>;

  /**
   * Fail a job (for internal use)
   */
  failJob(id: string, errorMessage: string, errorCode?: string): Promise<TranscriptionJobResponse>;

  /**
   * Cancel a job (tenant-scoped — internal/admin use)
   */
  cancelJob(id: string): Promise<TranscriptionJobResponse>;

  /**
   * EU-01 — creator-scoped cancel for the end-user surface: the
   * caller must be the job's `createdBy` (404 otherwise, no existence leak).
   */
  cancelJobForOwner(ownerId: string, id: string): Promise<TranscriptionJobResponse>;

  /**
   * Retry a failed job (tenant-scoped — internal/admin use)
   */
  retryJob(id: string): Promise<TranscriptionJobResponse>;

  /**
   * EU-01 — creator-scoped retry (mirrors {@link cancelJobForOwner}).
   */
  retryJobForOwner(ownerId: string, id: string): Promise<TranscriptionJobResponse>;

  /**
   * TASK-992 FU-1 — record what was published to the broker for this job, so a
   * later retry can re-publish it rather than only flipping a status.
   */
  recordDispatchEnvelope(id: string, envelope: BatchDispatchEnvelope): Promise<void>;

  /**
   * TASK-992 FU-1 — the creator-scoped read behind {@link retryJobForOwner}'s
   * dispatch. `envelope` is `null` for rows dispatched before FU-1 shipped.
   */
  getDispatchContextForOwner(
    ownerId: string,
    id: string,
  ): Promise<{ envelope: BatchDispatchEnvelope | null; resolvedSpec: unknown; tenantId: string }>;
}
