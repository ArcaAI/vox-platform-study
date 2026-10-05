/** One final utterance as posted by STT to `internal/stt/segments` (session-relative ms). */
export interface IngestSegment {
  utteranceIndex: number;
  text: string;
  speaker?: string;
  startMs: number;
  endMs: number;
  capturedAt: string;
  language?: string;
}

export interface IngestSegmentsInput {
  tenantId: string;
  consultationId: string;
  sttSessionId: string;
  audioOffsetMs: number;
  segments: IngestSegment[];
}

export interface IngestSegmentsResult {
  accepted: number;
  duplicates: number;
  lastSegmentSeq: number;
}

/**
 * Owns the consultation record built from speech: TRANSCRIPT_SEGMENT items, the derived
 * FULL_TRANSCRIPT item, the single AUDIO_RECORDING item, and storage of the per-encounter
 * FACT_LEDGER / ENCOUNTER_RECAP items (their producers live elsewhere).
 */
export abstract class ITranscriptRecordService {
  /** Idempotent on `${sttSessionId}:${utteranceIndex}`; an empty batch only touches activity. */
  abstract ingestSegments(input: IngestSegmentsInput): Promise<IngestSegmentsResult>;
  /** Rebuild FULL_TRANSCRIPT from the latest segment versions (ignores items with `metaData.origin`). */
  abstract onSessionFinal(input: {
    tenantId: string;
    consultationId: string;
    sttSessionId: string;
    sessionDurationMs?: number;
  }): Promise<{ contextItemId: string; versionNumber: number; segmentCount: number }>;
  abstract awaitFinal(consultationId: string, sttSessionIds: string[], timeoutMs: number): Promise<'complete' | 'pending'>;
  /** Appends the derived FULL_TRANSCRIPT version (changeSource `segment_edit`). */
  abstract onSegmentEdited(segmentItemId: string, versionNumber: number, changedBy: string): Promise<void>;
  abstract appendRecordingPart(input: {
    consultationId: string;
    audioRecordingId: string;
    mediaId: string;
    durationMs: number;
    encounterSeq: number;
    sttSessionId: string;
  }): Promise<{ contextItemId: string; versionNumber: number; totalMs: number }>;
  /** Create the item on first write, append a version after (one item per type and encounter). */
  abstract upsertEncounterArtifact(input: {
    consultationId: string;
    encounterSeq: number;
    type: 'FACT_LEDGER' | 'ENCOUNTER_RECAP';
    content: string;
    source: 'AI' | 'SYSTEM';
    changedBy: string;
    metaData: Record<string, unknown>;
  }): Promise<{ contextItemId: string; versionNumber: number }>;
}

export const ITranscriptRecordServiceToken = Symbol('ITranscriptRecordService');

/**
 * Lets the attachments feature claim a batch transcription it started. `true` means handled:
 * the STT batch path then writes no segments and emits no `TranscriptionCreated`.
 */
export abstract class IAttachmentTranscriptSink {
  abstract onBatchTranscript(input: { jobId: string; text: string }): Promise<boolean>;
  /** A batch job ended terminally without a transcript; `true` when an attachment owned it. */
  abstract onBatchFailure(input: { jobId: string; errorCode?: string }): Promise<boolean>;
}

export const IAttachmentTranscriptSinkToken = Symbol('IAttachmentTranscriptSink');
