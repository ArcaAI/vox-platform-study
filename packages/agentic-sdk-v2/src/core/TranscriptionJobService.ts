/**
 * @arcaai/vox - TranscriptionJobService
 *
 * Manages transcription job lifecycle:
 *   - Get job by ID
 *   - List jobs (paginated)
 *   - Get jobs by consultation / status
 *   - Get job status counts (stats)
 *   - Cancel / retry jobs
 *   - Poll job status with configurable interval
 *
 * @see SDK-206 Gap Analysis — ASR-R-08
 */

import type { AgenticClient } from './AgenticClient';
import { STT_ENDPOINTS } from './constants';
import type { ISDKLogger } from './logger';
import type { TranscriptionJobResponse, TranscriptionJobStatusCounts } from '../types/stt';

/**
 * Options for status polling
 */
export interface PollJobStatusOptions {
  /** Callback invoked on each status update */
  onUpdate: (job: TranscriptionJobResponse) => void;
  /** Callback invoked on fetch errors during polling */
  onError?: (error: Error) => void;
  /** Polling interval in milliseconds (default: 2000) */
  intervalMs?: number;
  /** Maximum polling attempts before giving up (default: unlimited) */
  maxAttempts?: number;
  /** Statuses that stop polling (e.g., COMPLETED, FAILED) */
  terminalStatuses: string[];
}

/**
 * Pagination parameters for list endpoints
 */
export interface JobListParams {
  page?: number;
  limit?: number;
}

/**
 * Service for tracking and managing transcription jobs via the stt API.
 */
export class TranscriptionJobService {
  private apiClient: AgenticClient;
  private logger?: ISDKLogger;
  private disposed = false;

  constructor(apiClient: AgenticClient, logger?: ISDKLogger) {
    this.apiClient = apiClient;
    this.logger = logger;
  }

  /**
   * Get a transcription job by ID.
   */
  async getJob(jobId: string): Promise<TranscriptionJobResponse> {
    this.logger?.debug('Fetching transcription job', {
      operation: 'getJob',
      component: 'TranscriptionJobService',
      attributes: { jobId },
    });

    return this.apiClient.get<TranscriptionJobResponse>(STT_ENDPOINTS.GET_JOB(jobId));
  }

  /**
   * List transcription jobs with optional pagination.
   */
  async listJobs(params?: JobListParams): Promise<TranscriptionJobResponse[]> {
    this.logger?.debug('Listing transcription jobs', {
      operation: 'listJobs',
      component: 'TranscriptionJobService',
      attributes: params as Record<string, unknown> | undefined,
    });

    let endpoint = STT_ENDPOINTS.LIST_JOBS;
    if (params) {
      const qs = new URLSearchParams();
      if (params.page !== undefined) qs.set('page', String(params.page));
      if (params.limit !== undefined) qs.set('limit', String(params.limit));
      const queryString = qs.toString();
      if (queryString) endpoint += `?${queryString}`;
    }

    return this.apiClient.get<TranscriptionJobResponse[]>(endpoint);
  }

  /**
   * Get transcription jobs linked to a specific consultation.
   */
  async getJobsByConsultation(consultationId: string): Promise<TranscriptionJobResponse[]> {
    this.logger?.debug('Fetching jobs by consultation', {
      operation: 'getJobsByConsultation',
      component: 'TranscriptionJobService',
      attributes: { consultationId },
    });

    return this.apiClient.get<TranscriptionJobResponse[]>(STT_ENDPOINTS.JOBS_BY_CONSULTATION(consultationId));
  }

  /**
   * Get transcription jobs filtered by status.
   */
  async getJobsByStatus(status: string): Promise<TranscriptionJobResponse[]> {
    this.logger?.debug('Fetching jobs by status', {
      operation: 'getJobsByStatus',
      component: 'TranscriptionJobService',
      attributes: { status },
    });

    return this.apiClient.get<TranscriptionJobResponse[]>(STT_ENDPOINTS.JOBS_BY_STATUS(status));
  }

  /**
   * Get aggregated job status counts.
   */
  async getJobStats(): Promise<TranscriptionJobStatusCounts> {
    this.logger?.debug('Fetching job stats', {
      operation: 'getJobStats',
      component: 'TranscriptionJobService',
    });

    return this.apiClient.get<TranscriptionJobStatusCounts>(STT_ENDPOINTS.JOB_STATS);
  }

  /**
   * Cancel a transcription job.
   */
  async cancelJob(jobId: string): Promise<TranscriptionJobResponse> {
    this.logger?.debug('Cancelling transcription job', {
      operation: 'cancelJob',
      component: 'TranscriptionJobService',
      attributes: { jobId },
    });

    return this.apiClient.post<TranscriptionJobResponse>(STT_ENDPOINTS.CANCEL_JOB(jobId), {});
  }

  /**
   * Retry a failed transcription job.
   */
  async retryJob(jobId: string): Promise<TranscriptionJobResponse> {
    this.logger?.debug('Retrying transcription job', {
      operation: 'retryJob',
      component: 'TranscriptionJobService',
      attributes: { jobId },
    });

    return this.apiClient.post<TranscriptionJobResponse>(STT_ENDPOINTS.RETRY_JOB(jobId), {});
  }

  /**
   * Poll job status at a configurable interval.
   * Resolves when a terminal status is reached or maxAttempts is exhausted.
   */
  async pollJobStatus(jobId: string, options: PollJobStatusOptions): Promise<void> {
    const { onUpdate, onError, intervalMs = 2000, maxAttempts, terminalStatuses } = options;

    let attempts = 0;

    while (!this.disposed) {
      if (maxAttempts !== undefined && attempts >= maxAttempts) {
        break;
      }

      try {
        const job = await this.getJob(jobId);
        attempts++;
        onUpdate(job);

        if (terminalStatuses.includes(job.status)) {
          break;
        }
      } catch (error) {
        attempts++;
        onError?.(error as Error);

        if (maxAttempts !== undefined && attempts >= maxAttempts) {
          break;
        }
      }

      // Wait before next poll (skip wait if disposed)
      if (!this.disposed) {
        await this.sleep(intervalMs);
      }
    }
  }

  /**
   * Stop any active polling and clean up.
   */
  dispose(): void {
    this.disposed = true;
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
