/**
 * Clinical Workflow Demonstration Playground — local DTO mirrors (TASK-330 P3).
 *
 * The server-side request/response shapes live in `@arcaai/applications`, which
 * is NOT importable from this Vite app. Following the admin console's pattern we
 * MIRROR the contracts we depend on as plain TS interfaces here. Keep these in
 * lockstep with:
 *   - `live-documentation/dto/recording.dto.ts`      (recording lifecycle)
 *   - `live-documentation/dto/live-summary.dto.ts`   (SSE payload)
 *   - `summary/dto/summary-provenance.response.ts`   (provenance)
 *   - `context/dto/add-context.request.ts`           (mid-visit context)
 */

// =============================================================================
// Recording lifecycle — POST /consultations/:id/recording/(start|stop)
// =============================================================================

/** Coarse consultation recording status reported by the backend. */
export type RecordingStatus = 'IDLE' | 'RECORDING' | 'STOPPED' | string;

/** Response of both the start and stop recording endpoints. */
export interface RecordingStateResponse {
  consultationId: string;
  status: RecordingStatus;
  /** Whether a live recording is currently in progress. */
  recording: boolean;
  /** STT stream session bound to the recording (when started with one). */
  sessionId?: string;
  /** Authenticated SSE URL for the live-summary stream (ticket appended client-side). */
  sseUrl: string;
  updatedAt: string;
}

/** POST /consultations/:id/recording/start body. */
export interface StartRecordingRequest {
  sessionId?: string;
}

/** POST /consultations/:id/recording/stop body. */
export interface StopRecordingRequest {
  /** Persist a final live-summary snapshot as a RAW_SUMMARY draft on stop. */
  persistSnapshot?: boolean;
}

// =============================================================================
// Live summary SSE — GET /consultations/:id/live-summary/stream
// =============================================================================

/** One named section of the running summary (e.g. "Subjective"). */
export interface LiveSummarySection {
  title: string;
  content: string;
}

/**
 * A medical entity recognised in the running summary. `start`/`end` are
 * character offsets into `runningSummary` used to render inline highlights.
 */
export interface LiveSummaryEntity {
  text: string;
  type: string;
  confidence: number;
  start: number;
  end: number;
}

/** Payload emitted on each `message` SSE event of the live-summary stream. */
export interface LiveSummaryEvent {
  consultationId: string;
  runningSummary: string;
  sections: LiveSummarySection[];
  entities: LiveSummaryEntity[];
  lastSegmentId?: string;
  updatedAt: string;
  /** `true` on the terminal event emitted when the recording stops. */
  closed?: boolean;
}

// =============================================================================
// Stream ticket — POST /auth/stream-ticket
// =============================================================================

export interface StreamTicketRequest {
  /** Scope string, e.g. `consultation_live_summary:<consultationId>`. */
  scope: string;
}

export interface StreamTicketResponse {
  ticket: string;
  expiresAt?: string;
}

// =============================================================================
// STT stream session — POST /api/v1/audio/transcription-jobs/stream/session
// =============================================================================

export interface CreateStreamSessionRequest {
  pipelineId?: string;
  consultationId?: string;
  language?: string;
}

export interface CreateStreamSessionResponse {
  sessionId: string;
  wsUrl?: string;
}

// =============================================================================
// Context items — POST /consultations/:id/context (+ GET list)
// =============================================================================

export type WorkspaceContextType =
  | 'CASE_NOTE'
  | 'WORKNOTE'
  | 'TRANSCRIPT'
  | 'ATTACHMENT'
  | 'AUDIO_RECORDING'
  | 'RAW_SUMMARY'
  | 'MODIFIED_SUMMARY'
  | 'SIGNED_NOTE'
  | string;

/** POST /consultations/:id/context body (mirrors AddContextRequest). */
export interface AddContextRequest {
  type: WorkspaceContextType;
  content: string;
  source?: string;
  mediaId?: string;
  metadata?: Record<string, unknown>;
  structuredData?: Record<string, unknown>;
}

/** A context item as returned by the consultation context endpoints. */
export interface WorkspaceContextItem {
  id: string;
  type: WorkspaceContextType;
  content: string;
  source?: string;
  mediaId?: string;
  status?: string;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
  structuredData?: Record<string, unknown> | null;
}

// =============================================================================
// Audio recordings — POST /consultations/:id/recordings (dual capture, WS3)
// =============================================================================

/** POST /consultations/:id/recordings body (mirrors AddAudioRecordingRequest). */
export interface AddAudioRecordingRequest {
  /** Canonical media id (the processed artifact for dual capture). */
  mediaId: string;
  /** Raw mic capture (pre-pipeline). */
  rawMediaId?: string;
  /** Processed capture (post-pipeline). */
  processedMediaId?: string;
  durationMs?: number;
  language?: string;
}

export interface AudioRecordingItem {
  id: string;
  sequenceNumber?: number;
  mediaId: string;
  rawMediaId?: string;
  processedMediaId?: string;
  durationFormatted?: string;
  language?: string;
  createdAt?: string;
}

// =============================================================================
// Provenance — GET /consultations/:id/summary/:ctxId/provenance
// =============================================================================

/** Mirrors SummaryProvenanceResponse (server). */
export interface SummaryProvenanceResponse {
  contextItemId: string;
  modelName?: string;
  status?: string;
  sensorScores?: {
    entityFaithfulness?: number;
    coverage?: number;
    schemaValid?: number;
    citationPresence?: number;
    numericDose?: number;
  } | null;
  /** Provenance map: claims with transcript-span evidence. */
  citationsMap?: unknown;
}

// =============================================================================
// Approve — POST /consultations/:id/summary/:ctxId/approve
// =============================================================================

export interface SummaryApprovalResponseDto {
  contextItemId: string;
  approvalStatus: string;
  approvedBy: string;
  approvedAt: string;
}

// =============================================================================
// Manual highlights — /consultations/:id/highlights (TASK-344 Workstream B)
//
// Doctor-authored highlights anchored to a PERSISTED surface via W3C dual
// selectors. A separate aggregate from the AI NER entities (LiveSummaryEntity)
// so manual marks never pollute the NER taxonomy. Mirrors:
//   - highlight/dto/create-highlight.request.ts
//   - highlight/dto/highlight.response.ts
// =============================================================================

/** Which persisted surface a manual highlight is anchored to. */
export type HighlightTargetKind = 'TRANSCRIPT' | 'CASE_NOTE' | 'WORKNOTE' | 'SUMMARY';

/** POST /consultations/:id/highlights body (mirrors CreateHighlightRequest). */
export interface CreateHighlightRequest {
  targetKind: HighlightTargetKind;
  /** W3C TextQuoteSelector exact — the selected text span. */
  exact: string;
  /** W3C TextPositionSelector offsets into the surface's plain text. */
  startOffset: number;
  endOffset: number;
  /** The persisted ContextItem id this highlight anchors to (when applicable). */
  sourceContextItemId?: string;
  prefix?: string;
  suffix?: string;
  color?: string;
  label?: string;
  note?: string;
}

/** A manual highlight as returned by the highlights endpoints (mirrors HighlightResponse). */
export interface WorkspaceHighlight {
  id: string;
  consultationId: string;
  sourceContextItemId?: string;
  targetKind: HighlightTargetKind;
  exact: string;
  prefix?: string;
  suffix?: string;
  startOffset: number;
  endOffset: number;
  color?: string;
  label?: string;
  note?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}
