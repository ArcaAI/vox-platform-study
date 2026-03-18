/**
 * Transcription SSE Event Types and DTOs
 *
 * These types define the structure of real-time events published via
 * Redis Pub/Sub (channel: stt:transcription:{jobId}) and forwarded
 * to clients as Server-Sent Events (SSE).
 *
 * Published by: STT-v2 Python service (TranscriptionEventPublisher)
 * Consumed by: TranscriptionRealtimeService -> SSE controller
 */

/**
 * Discriminator for transcription event types.
 */
export enum TranscriptionEventType {
    /** Job lifecycle transitions (QUEUED -> PROCESSING -> COMPLETED/FAILED) */
    STATUS = 'status',
    /** Processing percentage updates */
    PROGRESS = 'progress',
    /** Partial transcript as each audio segment completes */
    CHUNK = 'chunk',
    /** Full final transcript result */
    TRANSCRIPT = 'transcript',
    /** Failure notification */
    ERROR = 'error',
}

/**
 * Status event — job lifecycle transitions.
 */
export interface TranscriptionStatusEvent {
    jobId: string;
    status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    timestamp: string;
    workerId?: string;
}

/**
 * Progress event — processing percentage.
 */
export interface TranscriptionProgressEvent {
    jobId: string;
    progress: number;
    stage?: string;
}

/**
 * Word-level timestamp for transcript chunks and final results.
 */
export interface WordTimestamp {
    word: string;
    start: number;
    end: number;
    confidence: number;
}

/**
 * Sentence-level timestamp for final transcript results.
 */
export interface SentenceTimestamp {
    text: string;
    startTime: number;
    endTime: number;
}

/**
 * Chunk event — partial transcript as each audio segment completes.
 */
export interface TranscriptionChunkEvent {
    jobId: string;
    chunkIndex: number;
    text: string;
    startTime: number;
    endTime: number;
    isFinal: boolean;
    speaker?: string;
    speakerId?: string;
    speakerLabel?: string;
    speakerConfidence?: number;
    wordTimestamps?: WordTimestamp[];
}

/**
 * Transcript event — full final result after all chunks are processed.
 */
export interface TranscriptionTranscriptEvent {
    jobId: string;
    text: string;
    language?: string;
    languageProbability?: number;
    durationSeconds: number;
    processingTimeSeconds: number;
    wordTimestamps: WordTimestamp[];
    sentenceTimestamps: SentenceTimestamp[];
    metadata: Record<string, unknown>;
}

/**
 * Error event — failure notification.
 */
export interface TranscriptionErrorEvent {
    jobId: string;
    errorCode: string;
    message: string;
}

/**
 * Discriminated union of all transcription SSE events.
 *
 * Each event has a `type` discriminator and a typed `data` payload.
 * This is the JSON structure published to Redis and forwarded as SSE.
 */
export type TranscriptionEvent =
    | { type: TranscriptionEventType.STATUS; data: TranscriptionStatusEvent }
    | { type: TranscriptionEventType.PROGRESS; data: TranscriptionProgressEvent }
    | { type: TranscriptionEventType.CHUNK; data: TranscriptionChunkEvent }
    | { type: TranscriptionEventType.TRANSCRIPT; data: TranscriptionTranscriptEvent }
    | { type: TranscriptionEventType.ERROR; data: TranscriptionErrorEvent };
