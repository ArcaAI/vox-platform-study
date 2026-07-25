/**
 * Playground live transcription (frame 51, matrix row 35).
 * END-USER plane shapes mirrored from the gateway controller
 * (`apps/api/src/modules/streaming/transcription-job.controller.ts` + dto/):
 * owner-scoped jobs, streaming session envelope and the WS wire protocol.
 */

export type PlaygroundJobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DEAD';

/** Job states after which the row can no longer change (stop polling). */
export const TERMINAL_JOB_STATUSES: readonly PlaygroundJobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'];

/** GET /audio/transcription-jobs rows (TranscriptionJobResponse, owner-scoped). */
export interface PlaygroundTranscriptionJob {
    id: string;
    jobType: 'BATCH' | 'STREAMING';
    pipelineId: string;
    consultationId?: string | null;
    mediaId?: string | null;
    status: PlaygroundJobStatus;
    /** 0-100. */
    progress: number;
    queuedAt: string;
    startedAt?: string | null;
    completedAt?: string | null;
    resultText?: string | null;
    errorMessage?: string | null;
    errorCode?: string | null;
    retryCount: number;
    maxRetries: number;
    tenantId?: string;
    createdAt: string;
    updatedAt: string;
    createdBy?: string | null;
}

/**
 * List envelope (PaginatedTranscriptionJobResponse) — CUSTOM:
 * `total`/`totalPages` with a 1-BASED `page`, not the platform Paginated shape.
 */
export interface PaginatedPlaygroundJobs {
    data: PlaygroundTranscriptionJob[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

/** POST /audio/transcription-jobs/stream/session body (CreateStreamSessionRequest). */
export interface CreateStreamSessionInput {
    pipelineId: string;
    consultationId?: string;
    /** Negotiated capture rate; the gateway default is 16000. */
    sampleRate?: number;
    language?: string;
}

/** 201 envelope (StreamSessionResponse) — wsUrl is a gateway-relative WS path. */
export interface StreamSessionResponse {
    sessionId: string;
    status: string;
    wsUrl: string;
    maxConcurrent: number;
    currentActive: number;
    /** One-shot stream ticket — consumed by the first WS open. */
    ticket: string;
    /** Epoch milliseconds. */
    ticketExpiresAt: number;
    /** bridge to row 36 — caller's enrolled voice profile seeded diarization. */
    voiceProfileSeeded?: boolean;
}

/** POST …/stream/session/:sessionId/refresh-ticket. */
export interface RefreshTicketResponse {
    ticket: string;
    ticketExpiresAt: number;
}

/** POST /audio/transcription-jobs/transcribe 201 (BatchTranscribeResponse). */
export interface BatchTranscribeResponse {
    id: string;
    status: PlaygroundJobStatus;
    sseUrl: string;
    audioUri: string;
}

/** GET /audio/pipelines rows (PipelineResponse) — picker subset. */
export interface PlaygroundPipeline {
    id: string;
    name: string;
    slug: string;
    description?: string | null;
    /** Exactly one pipeline per tenant carries true. */
    isDefault: boolean;
    resourceStatus: string;
}

/** Gateway upload cap (MAX_FILE_SIZE in the controller dto). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** ALLOWED_AUDIO_MIMES mirrored from the controller dto. */
export const ACCEPTED_AUDIO_MIME_TYPES: readonly string[] = [
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/x-m4a',
    'audio/ogg',
    'audio/flac',
    'audio/x-flac',
    'audio/webm',
    'audio/aac',
];

// ---------------------------------------------------------------------------
// WS wire protocol (server → client). Local mirrors of
// packages/agentic-sdk-v2/src/types/stt.ts — @arcaai/vox ships with
// `dts: false`, so type-only imports from the package do not resolve.
// ---------------------------------------------------------------------------

export interface WsTranscriptPayload {
    type: 'transcript';
    text: string;
    startTime: number;
    endTime: number;
    isFinal: boolean;
    /** Monotonic server sequence number (resume handshake bookkeeping). */
    seq?: number;
    /** Backend inference/processing time in seconds — the latency meta. */
    inference?: number;
    /** Raw diarizer speaker id (`"Speaker 0"` / `"unknown"`); rendered as a fallback. */
    speakerId?: string;
    /** Canonical human-readable speaker label derived once by the bridge. */
    speakerLabel?: string;
    /** 'gloss' results are follow-up translations and never create a row. */
    resultType?: 'segment' | 'gloss';
}

export interface WsErrorPayload {
    type: 'error';
    code: string | number;
    message: string;
}

/**
 * SSE payload envelope on GET /audio/transcription-jobs/:id/stream
 * (TranscriptionEvent: `{ type, data }`, event name mirrors `type`).
 */
export interface JobStreamEnvelope {
    type: string;
    data?: {
        jobId?: string;
        status?: PlaygroundJobStatus;
        progress?: number;
        [key: string]: unknown;
    };
}
