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
   * Get jobs by consultation
   */
  getByConsultation(consultationId: string): Promise<TranscriptionJobResponse[]>;

  /**
   * Get paginated list of jobs
   */
  list(page: number, limit: number): Promise<PaginatedTranscriptionJobResponse>;

  /**
   * Get jobs by status
   */
  getByStatus(status: TranscriptionJobStatus): Promise<TranscriptionJobResponse[]>;

  /**
   * Get job status counts
   */
  getStatusCounts(): Promise<TranscriptionJobStatusCountResponse>;

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
   * Cancel a job
   */
  cancelJob(id: string): Promise<TranscriptionJobResponse>;

  /**
   * Retry a failed job
   */
  retryJob(id: string): Promise<TranscriptionJobResponse>;
}
