import { CreateTranscriptRequest, InternalUpdateProgressRequest, InternalStartJobRequest, InternalCompleteJobRequest, InternalFailJobRequest, CreateAudioRecordRequest, AudioRecordResponse } from './dto';
import { TranscriptionJobResponse } from '../job/dto';

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
     * Create an audio recording record
     * Called by STT-v2 after storing audio blob to MinIO
     */
    createAudioRecord(dto: CreateAudioRecordRequest): Promise<AudioRecordResponse>;
}
