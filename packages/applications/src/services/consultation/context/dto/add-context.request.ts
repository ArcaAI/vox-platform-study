import { IsString, IsOptional, IsObject, IsEnum, IsBoolean, IsNumber, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContextItemType, ContextItemSource } from '@arcaai/domains';

// F-03: caps tenant/doctor-authored content ingested verbatim into the
// harness prompt (`harness-internal.service.ts` assemble, `[case note]` /
// `[work note]` / attachment labels). 200k chars comfortably covers a long
// clinical note/attachment while bounding the worst-case prompt-injection /
// unbounded-payload surface (SOTA, F-03).
export const CONTEXT_CONTENT_MAX_LENGTH = 200_000;

export class AddContextRequest {
  @ApiProperty({
    description: 'Context type',
    enum: ContextItemType,
  })
  @IsEnum(ContextItemType)
  type: ContextItemType;

  @ApiPropertyOptional({ description: 'Content text (required for non-media types)' })
  @IsOptional()
  @IsString()
  @MaxLength(CONTEXT_CONTENT_MAX_LENGTH)
  content?: string;

  @ApiPropertyOptional({ description: 'Media ID of an uploaded file (for ATTACHMENT type)' })
  @IsOptional()
  @IsString()
  mediaId?: string;

  @ApiPropertyOptional({ description: 'DNA Writing Style ID (for summaries)' })
  @IsOptional()
  @IsString()
  dnaWritingStyleId?: string;

  @ApiPropertyOptional({
    description: 'Source of the content',
    enum: ContextItemSource,
    default: ContextItemSource.USER,
  })
  @IsOptional()
  @IsEnum(ContextItemSource)
  source?: ContextItemSource;

  @ApiPropertyOptional({
    description:
      'Free-form JSON metadata persisted on the context item. Convention: for lab/exam ATTACHMENTs set `{ "subType": "LAB_RESULT" }` (no new enum) so the clinical playground can render and fold the result into the live summary.',
    example: { subType: 'LAB_RESULT' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  // The tenant-defined context plane. Both fields MUST be DECLARED
  // here even though their contents are tenant-defined: the global pipe runs
  // `whitelist + forbidNonWhitelisted`, so anything undeclared is stripped
  // (silently, for `whitelist`) or rejected. The tenant-defined SHAPE rides
  // exactly one declared envelope (`payload`) and is validated in the service
  // layer against the pinned schema version.
  //
  // Omitting `kindKey` is the legacy path and is unchanged in every respect.
  @ApiPropertyOptional({
    description:
      "The tenant-declared context kind this item is an instance of (`kinds[].key` of the tenant's pinned " +
      'ConsultationContextSchema version). Omit it for the pre-existing behaviour: no schema is consulted and the ' +
      'write proceeds exactly as before.',
    example: 'referral_letter',
  })
  @IsOptional()
  @IsString()
  @MaxLength(48)
  kindKey?: string;

  @ApiPropertyOptional({
    description:
      "Structured payload for a STRUCTURED kind, validated against that kind's `fields` sub-schema in the PINNED " +
      'schema version. Requires `kindKey`. The validated payload is canonicalised and persisted through the same ' +
      'encrypted `content` column as every other text-bearing context type — there is no plaintext JSON column.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  // The loop event plane's cascade-depth lineage. Optional: a write
  // that omits it is depth 0 (a human/API-originated item), exactly as before
  // this field existed. A specialist (or any caller) that writes a NEW context
  // item as a consequence of processing ANOTHER one names that item here, so
  // `ContextService.addContext` can resolve `depth = parent.depth + 1` and cap
  // the cascade (depth-cap budget). A bad/cross-tenant reference
  // degrades to depth 0 rather than failing the write — lineage is metadata,
  // never a reason to lose clinical content.
  @ApiPropertyOptional({
    description:
      'The context item this one was DERIVED from (e.g. a specialist action writing back a finding). Used only to ' +
      'compute the loop cascade `depth` sent on the `ContextAdded` signal — never validated against a schema and ' +
      'never required. Omit for a normal, human/API-originated write (depth 0).',
  })
  @IsOptional()
  @IsString()
  derivedFromContextItemId?: string;
}

/**
 * Request to add audio recording(s) to a consultation
 */
export class AddAudioRecordingRequest {
  @ApiProperty({ description: 'Media ID from the Media table' })
  @IsString()
  mediaId: string;

  @ApiPropertyOptional({ description: 'Media ID of the RAW (unprocessed) capture (dual capture)' })
  @IsOptional()
  @IsString()
  rawMediaId?: string;

  @ApiPropertyOptional({ description: 'Media ID of the PROCESSED capture (dual capture)' })
  @IsOptional()
  @IsString()
  processedMediaId?: string;

  @ApiPropertyOptional({ description: 'Duration in milliseconds' })
  @IsOptional()
  duration?: number;

  @ApiPropertyOptional({ description: 'Audio format (e.g., wav, mp3, webm)' })
  @IsOptional()
  @IsString()
  format?: string;

  @ApiPropertyOptional({ description: 'Sample rate (e.g., 44100, 48000)' })
  @IsOptional()
  sampleRate?: number;

  @ApiPropertyOptional({ description: 'Number of channels (1 = mono, 2 = stereo)' })
  @IsOptional()
  channels?: number;

  @ApiPropertyOptional({ description: 'Bitrate (e.g., 128000)' })
  @IsOptional()
  bitrate?: number;

  @ApiPropertyOptional({ description: 'Language code' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: 'When the audio was recorded' })
  @IsOptional()
  recordedAt?: Date;
}

/**
 * Request to add a raw summary with AI metadata
 */
export class AddRawSummaryRequest {
  @ApiProperty({ description: 'Summary content text' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'DNA Writing Style ID' })
  @IsOptional()
  @IsString()
  dnaWritingStyleId?: string;

  @ApiPropertyOptional({ description: 'AI Model ID used for generation' })
  @IsOptional()
  @IsString()
  aiModelId?: string;

  @ApiPropertyOptional({ description: 'AI Model version' })
  @IsOptional()
  @IsString()
  aiModelVersion?: string;

  @ApiPropertyOptional({ description: 'Prompt version used' })
  @IsOptional()
  @IsString()
  promptVersion?: string;

  @ApiPropertyOptional({ description: 'Processing time in milliseconds' })
  @IsOptional()
  processingTimeMs?: number;

  @ApiPropertyOptional({ description: 'Input tokens used' })
  @IsOptional()
  inputTokens?: number;

  @ApiPropertyOptional({ description: 'Output tokens generated' })
  @IsOptional()
  outputTokens?: number;

  @ApiPropertyOptional({ description: 'IDs of case notes used as context' })
  @IsOptional()
  caseNoteIds?: string[];

  @ApiPropertyOptional({ description: 'IDs of pre-summaries used as context' })
  @IsOptional()
  preSummaryIds?: string[];

  @ApiPropertyOptional({ description: 'IDs of previous consultation summaries used as context' })
  @IsOptional()
  previousSummaryIds?: string[];

  @ApiPropertyOptional({ description: 'Whether this summary was served from cache' })
  @IsOptional()
  @IsBoolean()
  cacheHit?: boolean;

  @ApiPropertyOptional({ description: 'Quality/score of the generated summary (0.0 - 1.0)' })
  @IsOptional()
  @IsNumber()
  qualityScore?: number;
}

/**
 * Request to add named entities from NER
 */
export class AddNamedEntitiesRequest {
  @ApiProperty({ description: 'Array of recognized named entities' })
  entities: AddNamedEntityItem[];

  @ApiPropertyOptional({ description: 'AI Model ID used for recognition' })
  @IsOptional()
  @IsString()
  aiModelId?: string;

  @ApiPropertyOptional({ description: 'AI Model version' })
  @IsOptional()
  @IsString()
  aiModelVersion?: string;

  @ApiPropertyOptional({ description: 'Total processing time in milliseconds' })
  @IsOptional()
  processingTimeMs?: number;
}

export class AddNamedEntityItem {
  @ApiProperty({ description: 'The recognized text span' })
  @IsString()
  text: string;

  @ApiProperty({ description: 'Entity class (e.g., MEDICATION, CONDITION, PROCEDURE)' })
  @IsString()
  className: string;

  @ApiPropertyOptional({ description: 'Normalized/canonical form' })
  @IsOptional()
  @IsString()
  normalizedText?: string;

  @ApiPropertyOptional({ description: 'Character offset start' })
  @IsOptional()
  startOffset?: number;

  @ApiPropertyOptional({ description: 'Character offset end' })
  @IsOptional()
  endOffset?: number;

  @ApiPropertyOptional({ description: 'Confidence score (0.0 - 1.0)' })
  @IsOptional()
  confidence?: number;

  @ApiPropertyOptional({ description: 'Additional metadata (e.g., ICD codes)' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
