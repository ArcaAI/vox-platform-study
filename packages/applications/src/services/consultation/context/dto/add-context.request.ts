import { IsString, IsOptional, IsObject, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContextItemType, ContextItemSource } from '@arcaai/domains';

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
}

/**
 * Request to add audio recording(s) to a consultation
 */
export class AddAudioRecordingRequest {
  @ApiProperty({ description: 'Media ID from the Media table' })
  @IsString()
  mediaId: string;

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
