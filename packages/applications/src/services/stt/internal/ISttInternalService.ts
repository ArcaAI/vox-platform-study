import { TranscriptionJobResponse } from '../job/dto';
import {
  AudioRecordResponse,
  CreateAudioRecordRequest,
  CreateTranscriptRequest,
  InternalCreateMediaRequest,
  InternalCreateMediaResponse,
  InternalCompleteJobRequest,
  InternalFailJobRequest,
  InternalStartJobRequest,
  InternalUpdateProgressRequest,
} from './dto';

/**
 * Internal service interface for STT-v2 to call
 */
export interface ISttInternalService {
  /**
   * Create a transcript context item from completed transcription
   * Called by STT-v2 after transcription is complete
   */
  createTranscript(dto: CreateTranscriptRequest): Promise<{ contextItemId: string }>;

  /**
   * Start processing a job
   * Called by STT-v2 when worker picks up a job
   */
  startJob(jobId: string, dto: InternalStartJobRequest): Promise<TranscriptionJobResponse>;

  /**
   * Update job progress
   * Called by STT-v2 during transcription
   */
  updateProgress(jobId: string, dto: InternalUpdateProgressRequest): Promise<TranscriptionJobResponse>;

  /**
   * Complete a job
   * Called by STT-v2 when transcription is complete
   */
  completeJob(jobId: string, dto: InternalCompleteJobRequest): Promise<TranscriptionJobResponse>;

  /**
   * Fail a job
   * Called by STT-v2 when transcription fails
   */
  failJob(jobId: string, dto: InternalFailJobRequest): Promise<TranscriptionJobResponse>;

  /**
   * Get job status (lightweight check for worker cancellation polling)
   * Called by STT-v2 worker during processing
   */
  getJobStatus(jobId: string): Promise<{ status: string }>;

  /**
   * Create an audio recording record
   * Called by STT-v2 after storing audio blob to MinIO
   */
  createAudioRecord(dto: CreateAudioRecordRequest): Promise<AudioRecordResponse>;

  /**
   * Register a stored object as a `Media` row.
   * Called by STT-v2 for each dual-capture WAV before `createAudioRecord`.
   */
  createMedia(dto: InternalCreateMediaRequest): Promise<InternalCreateMediaResponse>;
}
