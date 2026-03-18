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

import type { AgenticClient } from './AgenticClient';
import { STT_V2_ENDPOINTS } from './constants';
import type { ISDKLogger } from './logger';
import type { TranscriptionJobResponse } from '../types/stt-v2';

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
  async uploadAndTranscribe(
    file: File,
    options: FileTranscribeOptions,
  ): Promise<TranscriptionJobResponse> {
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

    const job = await this.apiClient.postFormData<TranscriptionJobResponse>(
      STT_V2_ENDPOINTS.TRANSCRIBE,
      formData,
    );
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
