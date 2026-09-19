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
   * Slug of the published ASR Agent (task `SPEECH_TO_TEXT`) that should
   * transcribe this file (TASK-861/991). Optional: absent → the gateway
   * resolves the tenant's assigned agent (department → tenant → SYSTEM
   * cascade), same as `POST …/transcribe` without one. Wins over the
   * deprecated {@link FileTranscribeOptions.pipelineId} when both are set —
   * see `resolveAgentSelection` below, which mirrors
   * `StreamingSessionManager.normalizeSelection` (TASK-865): never both.
   */
  agentSlug?: string;
  /**
   * Pipeline UUID or slug.
   * @deprecated TASK-861 — removed in R4 (`AsrPipeline` retires under
   * TASK-861). Name the ASR Agent with {@link FileTranscribeOptions.agentSlug},
   * or send neither and let the tenant assignment cascade decide — the
   * gateway resolves tenant-default → configured STT fallback and 409s when
   * the tenant has neither, so it never guesses. When both are set the SDK
   * sends ONLY `agentSlug` and warns (never silently).
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

/** The two mutually-exclusive ASR selectors — see `FileTranscriptionService.resolveAgentSelection`. */
type AgentSelection = Pick<FileTranscribeOptions, 'agentSlug' | 'pipelineId'>;

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
    const selection = this.resolveAgentSelection(options);

    this.logger?.debug('Uploading file for transcription', {
      operation: 'uploadAndTranscribe',
      component: 'FileTranscriptionService',
      attributes: {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        agentSlug: selection.agentSlug,
        pipelineId: selection.pipelineId,
        consultationId: options.consultationId,
      },
    });

    const formData = new FormData();
    formData.append('file', file);
    // Appended only when supplied: the gateway validates each as a
    // slug/UUID, so sending an empty field would 400 the very request that
    // means "use the tenant default". At most one of the two rides the
    // request — see `resolveAgentSelection`.
    if (selection.agentSlug) {
      formData.append('agentSlug', selection.agentSlug);
    }
    if (selection.pipelineId) {
      formData.append('pipelineId', selection.pipelineId);
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

    const job = this.normalizeJobResponse(response, selection.pipelineId);
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
    const selection = this.resolveAgentSelection(options);

    this.logger?.debug('Uploading file for transcription (with progress)', {
      operation: 'uploadAndTranscribeWithProgress',
      component: 'FileTranscriptionService',
      attributes: {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        agentSlug: selection.agentSlug,
        pipelineId: selection.pipelineId,
        consultationId: options.consultationId,
      },
    });

    const formData = new FormData();
    formData.append('file', file);
    // Appended only when supplied: the gateway validates each as a
    // slug/UUID, so sending an empty field would 400 the very request that
    // means "use the tenant default". At most one of the two rides the
    // request — see `resolveAgentSelection`.
    if (selection.agentSlug) {
      formData.append('agentSlug', selection.agentSlug);
    }
    if (selection.pipelineId) {
      formData.append('pipelineId', selection.pipelineId);
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

    const job = this.normalizeJobResponse(response, selection.pipelineId);
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

  /**
   * Single chokepoint for WHICH ASR Agent (or deprecated pipeline) transcribes
   * this upload (TASK-991), mirroring `StreamingSessionManager.normalizeSelection`
   * (TASK-865). The multipart body carries AT MOST ONE of the two selectors:
   *   - both      → `agentSlug` only, and a warning naming the conflict;
   *   - pipeline  → sent as-is, with a deprecation warning;
   *   - neither   → nothing; the gateway resolves the tenant's assigned agent.
   * Never both silently: the gateway's own deprecated-path check
   * (`transcription-job.controller.ts#useLegacyPipelinePath`) takes the
   * pipeline path whenever `pipelineId` is present at all, so sending both
   * would make which selector is actually honoured a property of a field the
   * caller may not even know is checked first.
   */
  private resolveAgentSelection(options: AgentSelection): AgentSelection {
    const { agentSlug, pipelineId } = options;
    if (agentSlug) {
      if (pipelineId) {
        this.logger?.warn('uploadAndTranscribe received both agentSlug and pipelineId — agentSlug wins, pipelineId dropped', {
          operation: 'resolveAgentSelection',
          component: 'FileTranscriptionService',
          attributes: { agentSlug, droppedPipelineId: pipelineId, deprecation: 'TASK-861' },
        });
      }
      return { agentSlug };
    }
    if (pipelineId) {
      this.logger?.warn('pipelineId is deprecated (TASK-861, removed in R4) — name the ASR Agent with agentSlug, or send neither', {
        operation: 'resolveAgentSelection',
        component: 'FileTranscriptionService',
        attributes: { pipelineId, deprecation: 'TASK-861' },
      });
      return { pipelineId };
    }
    return {};
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
      // The authoritative value arrives with the terminal
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
