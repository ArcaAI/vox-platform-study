/**
 * Consultation Pipeline Event Definitions
 *
 * Domain events for the consultation auto-pipeline.
 * These events are emitted via EventEmitter2 and consumed by
 * ConsultationEventHandler to drive the automatic
 * Transcription → Summary → NER pipeline.
 *
 * Emitters:
 *   - SttInternalService → TranscriptionCreated
 * SummaryGenerated / NerExtracted had no producer left after
 *     deleted the legacy async summary/NER generators that used to emit
 *     them; `ConsultationEventHandler` still subscribes to both
 *     (out-of-scope defensive/dead code, not this ticket's to remove).
 *
 * Consumer:
 *   - ConsultationEventHandler (@OnEvent listeners)
 */

// =============================================================================
// Event Name Constants
// =============================================================================

/**
 * Consultation pipeline event names.
 *
 * Uses dot-notation namespacing consistent with the project's EventTypes
 * pattern (e.g., 'resource.created', 'user.authenticated').
 */
export enum ConsultationPipelineEvent {
  /** Emitted when a transcript context item is created from STT output */
  TranscriptionCreated = 'consultation.transcription.created',

  /**
   * Emitted when a non-transcript context item (WORKNOTE / CASE_NOTE /
   * ATTACHMENT / PRE_SUMMARY ...) is added to a consultation via the context
   * add path. Consumed by LiveDocumentationService so notes/labs/files added
   * mid-visit are folded into the running live summary. Does NOT drive the
   * harness pipeline.
   */
  ContextAdded = 'consultation.context.added',

  /**
   * Emitted when a live-tracked context item (WORKNOTE / CASE_NOTE /
   * ATTACHMENT) is soft-deleted via the context delete path.
   * Consumed by LiveDocumentationService so a note/lab/file removed mid-visit
   * drops out of the in-flight running summary. Does NOT drive the harness
   * pipeline (the durable assemble already excludes soft-deleted items).
   */
  ContextRemoved = 'consultation.context.removed',

  /** Emitted when an async summary job completes successfully */
  SummaryGenerated = 'consultation.summary.generated',

  /** Emitted when an async NER extraction job completes successfully */
  NerExtracted = 'consultation.ner.extracted',

  /** Emitted when the full pipeline (transcription → summary → NER) finishes */
  PipelineCompleted = 'consultation.pipeline.completed',

  /** Emitted when any pipeline step fails */
  PipelineStepFailed = 'consultation.pipeline.step_failed',
}

// =============================================================================
// Event Payload Interfaces
// =============================================================================

/**
 * Base payload shared by all consultation pipeline events.
 * Provides traceability fields for logging, auditing, and correlation.
 */
export interface ConsultationPipelineEventBase {
  /** The consultation this event belongs to */
  consultationId: string;

  /** Tenant ID for multi-tenancy scoping */
  tenantId: string;

  /** User who initiated the action (doctor, system, etc.) */
  userId?: string;

  /** ISO-8601 timestamp of when the event occurred */
  timestamp: string;

  /** Optional correlation ID for distributed tracing across pipeline steps */
  correlationId?: string;
}

/**
 * Payload for `ConsultationPipelineEvent.TranscriptionCreated`.
 *
 * Emitted by SttInternalService after a transcript ContextItem is persisted.
 * Triggers auto-summary generation if the pipeline config allows it.
 */
export interface TranscriptionCreatedPayload extends ConsultationPipelineEventBase {
  /** The created context item ID (TRANSCRIPT type) */
  contextItemId: string;

  /**
   * The STT transcription job ID that produced this transcript.
   * Optional — streaming sessions have no TranscriptionJob.
   */
  jobId?: string;

  /** Word count of the transcript (for logging/metrics) */
  wordCount?: number;

  /** Source of the transcription: streaming (WebSocket) or batch (file upload) */
  transcriptionSource: 'streaming' | 'batch';
}

/**
 * Payload for `ConsultationPipelineEvent.ContextAdded`.
 *
 * Emitted by ContextService.addContext after any non-transcript context item
 * is persisted. Carries a short content preview + the optional lab/exam
 * `metadata.subType` so the LiveDocumentationService can fold the note/lab/file
 * into the running summary without an extra DB round-trip.
 *
 * `kindKey`/`depth` and the fuller `content` field were added so
 * `LoopContextSignalService` can forward a payload-complete signal to the
 * consultation loop. `contentPreview` is UNCHANGED (still the 2k-char snippet
 * `LiveDocumentationService` folds into its live prompt) — `content` is a
 * SEPARATE, larger field so growing the loop's inline body never changes what
 * LiveDoc receives.
 */
export interface ContextAddedPayload extends ConsultationPipelineEventBase {
  /** The created context item id */
  contextItemId: string;

  /** The context item type (e.g., WORKNOTE, CASE_NOTE, ATTACHMENT) */
  contextType: string;

  /** Optional `metadata.subType` label (e.g., 'LAB_RESULT' for lab/exam attachments) */
  subType?: string;

  /** First ~2k chars of text content, when present (notes); absent for media-only attachments */
  contentPreview?: string;

  /**
   * The tenant-declared context kind this item is an instance of
   * (`ContextItem.kindKey`), when the write named one. Threaded to
   * the loop signal so subscriptions can match on the real kind instead of
   * falling back to `subType`/`contextType`.
   */
  kindKey?: string;

  /**
   * Cascade generation: a human/API-originated item is depth 0; an item
   * written with `derivedFromContextItemId` carries its parent's depth + 1
   * (`ContextItem.metaData.loopDepth`). Absent ⇒ 0.
   */
  depth?: number;

  /**
   * The full context body (up to `LOOP_SIGNAL_CONTENT_MAX_LENGTH`), threaded
   * inline to the loop signal so a specialist (`vision.extract_text`,
   * `nlp.extract_entities`) has real text to act on rather than the 2k-char
   * `contentPreview`. See `context.service.ts` for the size-threshold
   * reasoning.
   */
  content?: string;
}

/**
 * Payload for `ConsultationPipelineEvent.ContextRemoved`.
 *
 * Emitted by ContextService.deleteContext after a live-tracked context item is
 * soft-deleted. Mirrors the {@link ContextAddedPayload} traceability shape but
 * carries only the `contextItemId` — the LiveDocumentationService uses it to
 * drop the matching entry from the in-flight running summary's notes.
 */
export interface ContextRemovedPayload extends ConsultationPipelineEventBase {
  /** The soft-deleted context item id */
  contextItemId: string;
}

/**
 * Payload for `ConsultationPipelineEvent.SummaryGenerated`.
 *
 * Previously emitted by the legacy async summary generator after a summary
 * ContextItem was persisted (deleted — no current producer).
 * Triggers auto-NER extraction if the pipeline config allows it.
 */
export interface SummaryGeneratedPayload extends ConsultationPipelineEventBase {
  /** The created context item ID (RAW_SUMMARY type) */
  contextItemId: string;

  /** The BullMQ job ID that produced this summary */
  jobId: string;

  /** The DNA style ID used for generation (if any) */
  dnaStyleId?: string;

  /** The template used for generation (e.g., "SOAP") */
  template?: string;

  /** Whether this summary was auto-triggered by the pipeline (vs. manual request) */
  isAutoGenerated: boolean;

  /** AI model metadata */
  summaryMeta?: {
    aiModelId?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * Payload for `ConsultationPipelineEvent.NerExtracted`.
 *
 * Previously emitted by the legacy async NER generator after named entities
 * were persisted (deleted — no current producer).
 * This is the final step in the auto-pipeline.
 */
export interface NerExtractedPayload extends ConsultationPipelineEventBase {
  /** The context item ID that was analyzed */
  contextItemId: string;

  /** The BullMQ job ID that produced these entities */
  jobId: string;

  /** Number of entities extracted and saved */
  entityCount: number;

  /** Whether this NER extraction was auto-triggered by the pipeline */
  isAutoGenerated: boolean;

  /** Breakdown of entity counts by class (e.g., { MEDICATION: 3, CONDITION: 2 }) */
  entityCountByClass?: Record<string, number>;
}

/**
 * Payload for `ConsultationPipelineEvent.PipelineCompleted`.
 *
 * Emitted when the entire auto-pipeline finishes for a consultation.
 * Useful for frontend notifications and audit trails.
 */
export interface PipelineCompletedPayload extends ConsultationPipelineEventBase {
  /** The transcript context item that started the pipeline */
  transcriptContextItemId: string;

  /** The summary context item produced (if auto-summary was enabled) */
  summaryContextItemId?: string;

  /** Total number of NER entities extracted (if auto-NER was enabled) */
  totalEntityCount?: number;

  /** Total pipeline duration in milliseconds */
  pipelineDurationMs: number;

  /** Which steps were executed */
  stepsExecuted: PipelineStep[];
}

/**
 * Payload for `ConsultationPipelineEvent.PipelineStepFailed`.
 *
 * Emitted when a pipeline step fails. The pipeline may continue
 * or halt depending on configuration.
 */
export interface PipelineStepFailedPayload extends ConsultationPipelineEventBase {
  /** Which step failed */
  failedStep: PipelineStep;

  /** The job ID of the failed step (if applicable) */
  jobId?: string;

  /** The context item ID being processed when failure occurred */
  contextItemId?: string;

  /** Error message */
  error: string;

  /** Whether the pipeline will continue despite this failure */
  willContinue: boolean;
}

// =============================================================================
// Pipeline Configuration
// =============================================================================

/** Pipeline processing steps */
export type PipelineStep = 'transcription' | 'summary' | 'ner';

/**
 * Configuration for the automatic consultation processing pipeline.
 *
 * Stored in the consultation's `metadata` JSON field to allow
 * per-consultation, per-department, or per-tenant control over
 * which pipeline steps run automatically.
 *
 * Resolution order (first non-null wins):
 *   1. Consultation metadata.pipelineConfig
 *   2. Department default config
 *   3. Tenant default config
 *   4. System defaults (all enabled)
 */
export interface ConsultationPipelineConfig {
  /** Generate summary automatically after transcription completes */
  autoSummaryEnabled: boolean;

  /** Extract NER entities automatically after summary generation */
  autoNerEnabled: boolean;

  /** Default DNA style ID for auto-generated summaries */
  dnaStyleId?: string;

  /** Default summary template (e.g., "SOAP", "Hematology-New") */
  summaryTemplate?: string;

  /** Include shared context from other consultations in auto-summary */
  includeSharedContext?: boolean;

  /** Stop pipeline on step failure, or continue remaining steps */
  haltOnFailure?: boolean;

  /**
   * (Lane G) — route auto-generation to the durable harness
   * workflow (apps/harness) instead of the legacy BullMQ summary job. Defaults
   * to false/undefined, so existing consultations keep the legacy pipeline.
   */
  harnessEnabled?: boolean;
}

/**
 * System defaults for pipeline configuration.
 * Applied when no consultation/department/tenant override exists.
 */
export const DEFAULT_PIPELINE_CONFIG: ConsultationPipelineConfig = {
  autoSummaryEnabled: true,
  autoNerEnabled: true,
  haltOnFailure: false,
};

// =============================================================================
// Event Payload Union Type
// =============================================================================

/**
 * Discriminated union mapping event names to their typed payloads.
 * Used by ConsultationEventHandler for type-safe event handling.
 */
export type ConsultationPipelineEventPayloadMap = {
  [ConsultationPipelineEvent.TranscriptionCreated]: TranscriptionCreatedPayload;
  [ConsultationPipelineEvent.ContextAdded]: ContextAddedPayload;
  [ConsultationPipelineEvent.ContextRemoved]: ContextRemovedPayload;
  [ConsultationPipelineEvent.SummaryGenerated]: SummaryGeneratedPayload;
  [ConsultationPipelineEvent.NerExtracted]: NerExtractedPayload;
  [ConsultationPipelineEvent.PipelineCompleted]: PipelineCompletedPayload;
  [ConsultationPipelineEvent.PipelineStepFailed]: PipelineStepFailedPayload;
};
