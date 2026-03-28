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

import { TranscriptionJobStatus, TranscriptionJobType, type TranscriptionJobResponse } from '../types/stt-v2';
import type { AgenticClient } from './AgenticClient';
import { STT_V2_ENDPOINTS } from './constants';
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
  /** Pipeline UUID or slug (required) */
  pipelineId: string;
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
  async uploadAndTranscribe(file: File, options: FileTranscribeOptions): Promise<TranscriptionJobResponse> {
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
    formData.append('pipelineId', options.pipelineId);

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

    const response = await this.apiClient.postFormData<TranscriptionJobResponse | BatchTranscribeResponse>(STT_V2_ENDPOINTS.TRANSCRIBE, formData);

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

  private normalizeJobResponse(response: TranscriptionJobResponse | BatchTranscribeResponse, pipelineId: string): TranscriptionJobResponse {
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
      pipelineId,
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
    return `${this.apiClient.getBaseUrl()}${STT_V2_ENDPOINTS.JOB_STREAM(jobId)}`;
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
