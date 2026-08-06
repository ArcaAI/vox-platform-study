/**
 * @arcaai/vox - FileTranscriptionService
 *
 * Handles file upload transcription workflow:
 *   1. Upload audio file via POST /api/v1/transcription-jobs/transcribe (multipart/form-data)
 *   2. Receive job response with ID
 *   3. Build SSE stream URL for subscribing to results
 *
 * The SSE subscription itself is handled by SSEClient (ASR-R-09).
 * This service focuses on the upload step and URL construction.
 *
 * @see SDK-206 Gap Analysis — ASR-R-10
 */

import type { PaginatedResponse } from '../types/common';
import { TranscriptionJobStatus, TranscriptionJobType, type TranscriptionJobResponse } from '../types/stt';
import type { AgenticClient } from './AgenticClient';
import { STT_ENDPOINTS } from './constants';
import type { ISDKLogger } from './logger';

type BatchTranscribeResponse = {
  id: string;
  status: string;
  sseUrl?: string;
  audioUri?: string;
};

/**
 * Options for file transcription upload
 */
export interface FileTranscribeOptions {
  /**
   * Pipeline UUID or slug. OPTIONAL since TASK-614: omit it to transcribe on
   * the tenant's default pipeline — the gateway resolves tenant-default →
   * configured STT fallback and 409s when the tenant has neither, so it never
   * guesses. Passing one explicitly is unchanged.
   */
  pipelineId?: string;
  /** Optional consultation to link the job to */
  consultationId?: string;
  /** Audio sample rate in Hz */
  sampleRate?: number;
  /** ISO 639-1 language code */
  language?: string;
  /** Enable multilingual code-switching (overrides pipeline default) */
  codeSwitching?: boolean;
  /** Enable speaker diarization (overrides pipeline default) */
  diarization?: boolean;
}

/**
 * Service for uploading audio files for transcription.
 */
export class FileTranscriptionService {
  private apiClient: AgenticClient;
  private logger?: ISDKLogger;
  private activeJobId: string | null = null;

  constructor(apiClient: AgenticClient, logger?: ISDKLogger) {
    this.apiClient = apiClient;
    this.logger = logger;
  }

  /**
   * Upload an audio file for transcription.
   *
   * Sends a multipart/form-data POST to the transcribe endpoint.
   * Returns the job response with the job ID for SSE subscription.
   */
  async uploadAndTranscribe(file: File, options: FileTranscribeOptions & { signal?: AbortSignal }): Promise<TranscriptionJobResponse> {
    this.logger?.debug('Uploading file for transcription', {
      operation: 'uploadAndTranscribe',
      component: 'FileTranscriptionService',
      attributes: {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        pipelineId: options.pipelineId,
        consultationId: options.consultationId,
      },
    });

    const formData = new FormData();
    formData.append('file', file);
    // Appended only when supplied (TASK-614): the gateway validates `pipelineId`
    // as a slug/UUID, so sending an empty field would 400 the very request that
    // means "use the tenant default".
    if (options.pipelineId) {
      formData.append('pipelineId', options.pipelineId);
    }

    if (options.consultationId) {
      formData.append('consultationId', options.consultationId);
    }
    if (options.language) {
      formData.append('language', options.language);
    }
    if (options.sampleRate !== undefined) {
      formData.append('sampleRate', String(options.sampleRate));
    }
    if (options.codeSwitching !== undefined) {
      formData.append('codeSwitching', String(options.codeSwitching));
    }
    if (options.diarization !== undefined) {
      formData.append('diarization', String(options.diarization));
    }

    const response = await this.apiClient.postFormData<TranscriptionJobResponse | BatchTranscribeResponse>(STT_ENDPOINTS.TRANSCRIBE, formData, {
      signal: options.signal,
    });

    const job = this.normalizeJobResponse(response, options.pipelineId);
    this.activeJobId = job.id;

    this.logger?.info('File uploaded for transcription', {
      operation: 'uploadAndTranscribe',
      component: 'FileTranscriptionService',
      success: true,
      attributes: {
        jobId: job.id,
        status: job.status,
        pipelineId: job.pipelineId,
      },
    });

    return job;
  }

  async uploadAndTranscribeWithProgress(
    file: File,
    options: FileTranscribeOptions & {
      signal?: AbortSignal;
      onProgress?: (progress: number) => void;
      /**
       * Per-upload XHR timeout in milliseconds. Defaults to `0` (no timeout) since medical audio
       * files of 20+ minutes routinely exceed short client-wide defaults. Cancellation should be
       * driven by `signal` (user-initiated abort) and network errors are reported via `onerror`.
       */
      timeout?: number;
    },
  ): Promise<TranscriptionJobResponse> {
    this.logger?.debug('Uploading file for transcription (with progress)', {
      operation: 'uploadAndTranscribeWithProgress',
      component: 'FileTranscriptionService',
      attributes: {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        pipelineId: options.pipelineId,
        consultationId: options.consultationId,
      },
    });

    const formData = new FormData();
    formData.append('file', file);
    // Appended only when supplied (TASK-614): the gateway validates `pipelineId`
    // as a slug/UUID, so sending an empty field would 400 the very request that
    // means "use the tenant default".
    if (options.pipelineId) {
      formData.append('pipelineId', options.pipelineId);
    }

    if (options.consultationId) {
      formData.append('consultationId', options.consultationId);
    }
    if (options.language) {
      formData.append('language', options.language);
    }
    if (options.sampleRate !== undefined) {
      formData.append('sampleRate', String(options.sampleRate));
    }
    if (options.codeSwitching !== undefined) {
      formData.append('codeSwitching', String(options.codeSwitching));
    }
    if (options.diarization !== undefined) {
      formData.append('diarization', String(options.diarization));
    }

    const response = await this.apiClient.uploadFormData<TranscriptionJobResponse | BatchTranscribeResponse>(STT_ENDPOINTS.TRANSCRIBE, formData, {
      signal: options.signal,
      onProgress: options.onProgress,
      // Default: disable the XHR timeout for batch audio uploads. Arbitrary-length medical
      // recordings must not be cut off by a 30-second client-wide default. Cancellation is
      // handled explicitly via `signal`.
      timeout: options.timeout ?? 0,
    });

    const job = this.normalizeJobResponse(response, options.pipelineId);
    this.activeJobId = job.id;

    this.logger?.info('File uploaded for transcription (with progress)', {
      operation: 'uploadAndTranscribeWithProgress',
      component: 'FileTranscriptionService',
      success: true,
      attributes: {
        jobId: job.id,
        status: job.status,
        pipelineId: job.pipelineId,
      },
    });

    return job;
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.apiClient.post(STT_ENDPOINTS.CANCEL_JOB(jobId));
    if (this.activeJobId === jobId) {
      this.activeJobId = null;
    }
  }

  async getJob(jobId: string): Promise<TranscriptionJobResponse> {
    return this.apiClient.get<TranscriptionJobResponse>(STT_ENDPOINTS.GET_JOB(jobId));
  }

  async listJobs(params?: { page?: number; limit?: number }): Promise<PaginatedResponse<TranscriptionJobResponse>> {
    const query = new URLSearchParams();
    if (params?.page !== undefined) query.set('page', String(params.page));
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    const endpoint = qs ? `${STT_ENDPOINTS.LIST_JOBS}?${qs}` : STT_ENDPOINTS.LIST_JOBS;
    return this.apiClient.get<PaginatedResponse<TranscriptionJobResponse>>(endpoint);
  }

  private normalizeJobResponse(response: TranscriptionJobResponse | BatchTranscribeResponse, pipelineId?: string): TranscriptionJobResponse {
    // If the response already has the full TranscriptionJobResponse shape, return it directly
    const asFull = response as Partial<TranscriptionJobResponse>;
    if (asFull.jobType !== undefined && typeof asFull.id === 'string' && asFull.id.length > 0) {
      return response as TranscriptionJobResponse;
    }

    // Batch response: map minimal fields to TranscriptionJobResponse
    const batch = response as BatchTranscribeResponse;
    if (!batch.id) {
      throw new Error('Invalid transcription response: missing job id');
    }

    const status = (batch.status ?? '').trim().toUpperCase() as TranscriptionJobStatus;
    const validStatuses: string[] = Object.values(TranscriptionJobStatus);
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid transcription response status: ${batch.status}`);
    }

    return {
      id: batch.id,
      jobType: TranscriptionJobType.BATCH,
      // The minimal batch response carries no pipeline, so this echoes what was
      // REQUESTED. Empty when the caller let the tenant default apply
      // (TASK-614) — the authoritative value arrives with the terminal
      // `getJob()` read, which the queue uses for the completed item.
      pipelineId: pipelineId ?? '',
      status,
      progress: 0,
      retryCount: 0,
      maxRetries: 0,
      tenantId: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Build the SSE stream URL for a transcription job.
   * Used to subscribe to real-time results via SSEClient.
   */
  buildJobStreamUrl(jobId: string): string {
    return `${this.apiClient.getBaseUrl()}${STT_ENDPOINTS.JOB_STREAM(jobId)}`;
  }

  /**
   * Get the ID of the most recently uploaded job.
   */
  getActiveJobId(): string | null {
    return this.activeJobId;
  }

  /**
   * Clean up and reset state.
   */
  dispose(): void {
    this.activeJobId = null;
  }
}
