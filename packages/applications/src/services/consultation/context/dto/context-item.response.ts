import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContextItemType, ContextItemSource } from '@arcaai/domains';

/**
 * Audio Recording Response
 */
export class AudioRecordingResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  mediaId: string;

  @ApiPropertyOptional({ description: 'Media ID of the RAW (unprocessed) capture (dual capture)' })
  rawMediaId?: string;

  @ApiPropertyOptional({ description: 'Media ID of the PROCESSED capture (dual capture)' })
  processedMediaId?: string;

  @ApiPropertyOptional({ description: 'Duration in milliseconds' })
  duration?: number;

  @ApiPropertyOptional({ description: 'Duration formatted as MM:SS' })
  durationFormatted?: string;

  @ApiPropertyOptional({ description: 'Audio format' })
  format?: string;

  @ApiPropertyOptional({ description: 'Sample rate' })
  sampleRate?: number;

  @ApiPropertyOptional({ description: 'Number of channels' })
  channels?: number;

  @ApiPropertyOptional({ description: 'Bitrate' })
  bitrate?: number;

  @ApiPropertyOptional({ description: 'Language code' })
  language?: string;

  @ApiProperty({ description: 'Sequence number for ordering' })
  sequenceNumber: number;

  @ApiPropertyOptional({ description: 'When the audio was recorded' })
  recordedAt?: string;

  @ApiProperty()
  createdAt: string;
}

/**
 * Summary Metadata Response
 */
export class SummaryMetaResponse {
  @ApiProperty()
  id: string;

  @ApiPropertyOptional({ description: 'AI Model ID used' })
  aiModelId?: string;

  @ApiPropertyOptional({ description: 'AI Model version' })
  aiModelVersion?: string;

  @ApiPropertyOptional({ description: 'Prompt version' })
  promptVersion?: string;

  @ApiPropertyOptional({ description: 'Processing time in milliseconds' })
  processingTimeMs?: number;

  @ApiPropertyOptional({ description: 'Processing time in seconds' })
  processingTimeSeconds?: number;

  @ApiPropertyOptional({ description: 'Input tokens used' })
  inputTokens?: number;

  @ApiPropertyOptional({ description: 'Output tokens generated' })
  outputTokens?: number;

  @ApiPropertyOptional({ description: 'Total tokens used' })
  totalTokens?: number;

  @ApiPropertyOptional({ description: 'IDs of case notes used as context' })
  caseNoteIds?: string[];

  @ApiPropertyOptional({ description: 'IDs of pre-summaries used as context' })
  preSummaryIds?: string[];

  @ApiPropertyOptional({ description: 'IDs of previous consultation summaries used' })
  previousSummaryIds?: string[];

  @ApiProperty({ description: 'Whether any context was used for generation' })
  hasAnyContext: boolean;

  @ApiPropertyOptional({ description: 'When the summary was generated' })
  generatedAt?: string;

  @ApiPropertyOptional({ description: 'Whether this summary was served from cache' })
  cacheHit?: boolean;

  @ApiPropertyOptional({ description: 'Quality/score of the generated summary (0.0 - 1.0)' })
  qualityScore?: number;

  @ApiPropertyOptional({
    description: 'Prompt-resolution tier that produced the summary',
    enum: ['preferred', 'department', 'default'],
  })
  promptResolvedFrom?: 'preferred' | 'department' | 'default';

  @ApiPropertyOptional({ description: 'The prompt id actually used to generate the summary' })
  resolvedPromptId?: string;

  @ApiProperty()
  createdAt: string;
}

/**
 * Named Entity Response
 */
export class NamedEntityResponse {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'The recognized text span' })
  text: string;

  @ApiProperty({ description: 'Entity class (e.g., MEDICATION, CONDITION)' })
  className: string;

  @ApiPropertyOptional({ description: 'Normalized/canonical form' })
  normalizedText?: string;

  @ApiProperty({ description: 'Display text (normalized if available, otherwise original)' })
  displayText: string;

  @ApiPropertyOptional({ description: 'Character offset start' })
  startOffset?: number;

  @ApiPropertyOptional({ description: 'Character offset end' })
  endOffset?: number;

  @ApiPropertyOptional({ description: 'Confidence score (0.0 - 1.0)' })
  confidence?: number;

  @ApiProperty({ description: 'Whether confidence is high (>= 0.8)' })
  isHighConfidence: boolean;

  @ApiPropertyOptional({ description: 'AI Model ID used' })
  aiModelId?: string;

  @ApiPropertyOptional({ description: 'AI Model version' })
  aiModelVersion?: string;

  @ApiPropertyOptional({ description: 'Processing time in milliseconds' })
  processingTimeMs?: number;

  @ApiPropertyOptional({ description: 'Additional metadata' })
  metadata?: Record<string, unknown>;

  @ApiProperty()
  createdAt: string;
}

/**
 * Context Item Version Response
 */
export class ContextItemVersionResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  contextItemId: string;

  @ApiProperty()
  versionNumber: number;

  @ApiPropertyOptional()
  content?: string;

  @ApiPropertyOptional({ description: 'Content diff from previous version' })
  contentDiff?: string;

  @ApiPropertyOptional({ description: 'Reason for the change' })
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Summary of what changed' })
  changeSummary?: string;

  @ApiPropertyOptional({ description: 'User who made the change' })
  changedBy?: string;

  @ApiPropertyOptional({ description: 'Source of the change (manual, ai, system)' })
  changeSource?: string;

  @ApiPropertyOptional({ description: 'Field-level changes' })
  fieldChanges?: Record<string, unknown>;

  @ApiProperty()
  createdAt: string;
}

/**
 * Context Item Response
 *
 * Note: This class must be defined after its dependent classes
 * (AudioRecordingResponse, SummaryMetaResponse, etc.) to avoid
 * "Cannot access before initialization" errors at runtime.
 */
export class ContextItemResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  consultationId: string;

  @ApiProperty({ enum: ContextItemType })
  type: ContextItemType;

  @ApiProperty({ enum: ContextItemSource })
  source: ContextItemSource;

  @ApiPropertyOptional({ description: 'Text content (for non-media types)' })
  content?: string;

  @ApiPropertyOptional({ description: 'Media ID of the uploaded file (for ATTACHMENT type)' })
  mediaId?: string;

  @ApiPropertyOptional({
    description:
      'Short-lived accessible (presigned) download URL for the attached media, resolved from storage when available. Absent when the item has no media or storage resolution is unavailable.',
  })
  url?: string;

  @ApiPropertyOptional({ description: 'MIME type of the attached media (e.g. image/png, application/pdf, audio/wav)' })
  mimeType?: string;

  @ApiPropertyOptional({
    description:
      'Presigned URL of a real downscaled WebP thumbnail for image attachments (generated on upload, addressed by a deterministic derived key). Falls back to the full-size image URL for media without a derivative; absent for non-images.',
  })
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'DNA Writing Style ID' })
  dnaWritingStyleId?: string;

  @ApiPropertyOptional({
    description: 'Free-form JSON metadata. Convention: lab/exam ATTACHMENTs carry `{ "subType": "LAB_RESULT" }` (Clinical Workflow Playground WS5).',
  })
  metadata?: Record<string, unknown>;

  @ApiProperty({ description: 'Current version number of the context item' })
  currentVersionNumber: number;

  @ApiProperty({ description: 'Whether synced to Qdrant vector DB' })
  qdrantSynced: boolean;

  @ApiPropertyOptional({ description: 'Last Qdrant sync timestamp' })
  qdrantSyncedAt?: string;

  @ApiProperty({ description: 'Derived: true if type is RAW_SUMMARY, MODIFIED_SUMMARY, or PRE_SUMMARY' })
  isSummary: boolean;

  @ApiProperty({ description: 'Derived: true if type is RAW_SUMMARY or MODIFIED_SUMMARY (excludes PRE_SUMMARY)' })
  isFinalSummary: boolean;

  @ApiProperty({ description: 'Derived: true if type is PRE_SUMMARY' })
  isPreSummary: boolean;

  @ApiProperty({ description: 'Derived: true if type is TRANSCRIPT' })
  isTranscript: boolean;

  @ApiProperty({ description: 'Derived: true if type is CASE_NOTE' })
  isCaseNote: boolean;

  @ApiProperty({ description: 'Derived: true if type is WORKNOTE' })
  isWorknote: boolean;

  @ApiProperty({ description: 'Derived: true if type is NAMED_ENTITY' })
  isNamedEntity: boolean;

  @ApiProperty({ description: 'Derived: true if type is ATTACHMENT' })
  isAttachment: boolean;

  @ApiProperty({ description: 'Derived: true if source is AI' })
  isAiGenerated: boolean;

  @ApiProperty({ description: 'Derived: true if type is AUDIO_RECORDING or ATTACHMENT' })
  isMediaType: boolean;

  @ApiPropertyOptional({ description: 'Audio recordings (when type is AUDIO_RECORDING)', type: [AudioRecordingResponse] })
  audioRecordings?: AudioRecordingResponse[];

  @ApiPropertyOptional({ description: 'Summary metadata (when type is RAW_SUMMARY, MODIFIED_SUMMARY, or PRE_SUMMARY)', type: SummaryMetaResponse })
  summaryMeta?: SummaryMetaResponse;

  @ApiPropertyOptional({ description: 'Named entities (when available)', type: [NamedEntityResponse] })
  namedEntities?: NamedEntityResponse[];

  @ApiPropertyOptional({ description: 'Version history', type: [ContextItemVersionResponse] })
  versions?: ContextItemVersionResponse[];

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;

  /**
   * TASK-709: Surface `_version` (the OCC compare-and-set counter, DISTINCT
   * from `currentVersionNumber` — the content-revision pointer above) so SDK
   * clients can echo it back via `If-Match: "<version>"` (or the body-field
   * `expectedVersion`) on the next PATCH. Mirrors
   * `DepartmentResponse.version` (`department.response.ts`) — the house
   * exemplar for this field.
   */
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 7,
  })
  version!: number;
}
