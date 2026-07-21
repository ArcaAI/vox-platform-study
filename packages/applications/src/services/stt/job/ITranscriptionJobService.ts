import {
  CreateJobRequest,
  CreateBatchJobRequest,
  CreateStreamingJobRequest,
  TranscriptionJobResponse,
  PaginatedTranscriptionJobResponse,
  TranscriptionJobStatusCountResponse,
} from './dto';
import { TranscriptionJobStatus } from '@arcaai/domains';
import { JsonValue } from '@arcaai/domains';

export interface ITranscriptionJobService {
  /**
   * Create a transcription job
   */
  create(dto: CreateJobRequest): Promise<TranscriptionJobResponse>;

  /**
   * Create a batch transcription job
   */
  createBatchJob(dto: CreateBatchJobRequest): Promise<TranscriptionJobResponse>;

  /**
   * Create a streaming transcription job
   */
  createStreamingJob(dto: CreateStreamingJobRequest): Promise<TranscriptionJobResponse>;

  /**
   * Get job by ID
   */
  getById(id: string): Promise<TranscriptionJobResponse | null>;

  /**
   * Get job by ID with pipeline details
   */
  getByIdWithPipeline(id: string): Promise<TranscriptionJobResponse | null>;

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
  list(page: number, limit: number): Promise<PaginatedTranscriptionJobResponse>;

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
}
