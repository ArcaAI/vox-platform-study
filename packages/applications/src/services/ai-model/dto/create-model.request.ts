import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsArray, IsBoolean, IsEnum, IsIn, IsNumber, Matches, MaxLength, MinLength, Min } from 'class-validator';
import { AiDeploymentKind, AiTaskKind, ModelCategory, ModelTaskType, ModelType, AiModelSource, AiModelFormat } from '@arcaai/domains';
import { AI_MODEL_LIBRARIES, AI_MODEL_PROVIDERS, AI_MODEL_SERVED_BY, DISCOVERABLE_AI_MODEL_PROVIDERS } from '../constants';

// The vocabularies live in `../constants` since TASK-860; re-exported here so
// existing importers of the DTO module keep resolving them.
export { AI_MODEL_PROVIDERS, DISCOVERABLE_AI_MODEL_PROVIDERS };

/**
 * `POST admin/ai-models` — register a catalogue row.
 *
 * Every row lands in the SYSTEM tenant (the service pins it) and is written by
 * a platform admin only. `localPath` is deliberately ABSENT: it is derived
 * from `bucketPrefix` (+ `primaryObject`) by the service, and the global
 * `forbidNonWhitelisted` pipe rejects a body that carries it.
 */
export class CreateModelRequest {
  @ApiProperty({
    description: 'Model name',
    example: 'Whisper Large V3',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    description: 'URL-friendly unique identifier',
    example: 'whisper-large-v3',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens',
  })
  slug: string;

  @ApiPropertyOptional({
    description: 'Model description',
    example: 'OpenAI Whisper Large V3 for high-accuracy speech recognition',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({
    description: 'Model category',
    enum: ModelCategory,
    example: ModelCategory.AUDIO,
  })
  @IsEnum(ModelCategory)
  category: ModelCategory;

  @ApiProperty({
    description: 'Hugging Face task (`pipeline_tag`) as the SCREAMING_CASE enum member; the response derives the kebab-case `pipelineTag`.',
    enum: ModelTaskType,
    example: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
  })
  @IsEnum(ModelTaskType)
  taskType: ModelTaskType;

  @ApiProperty({
    description: 'Model type',
    enum: ModelType,
    example: ModelType.BASE_MODEL,
  })
  @IsEnum(ModelType)
  modelType: ModelType;

  @ApiProperty({
    description: 'Model source. S3 = S3/MinIO-compatible object storage (s3:// only; azure-blob:// is out of scope).',
    enum: AiModelSource,
    example: AiModelSource.HUGGINGFACE,
  })
  @IsEnum(AiModelSource)
  source: AiModelSource;

  @ApiProperty({
    description:
      'Source URI. Scheme grammar honoured by every service resolver: ' +
      '`hf:<org>/<repo>` or a bare HuggingFace id (Hub snapshot, honours HF_HUB_OFFLINE) · ' +
      '`file:///abs/path` (verified in place, never copied) · ' +
      '`s3://bucket/prefix` (downloaded once into the service cache, single-flight + SHA256-verified). ' +
      'Any other scheme is rejected — there is no silent fallback.',
    example: 'openai/whisper-large-v3',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  sourceUri: string;

  @ApiPropertyOptional({
    description: 'Source revision (git commit, tag, or MLFlow version)',
    example: 'main',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  sourceRevision?: string;

  @ApiProperty({
    description: 'Artifact format (descriptive; loader selection is `libraryName`).',
    enum: AiModelFormat,
    example: AiModelFormat.SAFETENSOR,
  })
  @IsEnum(AiModelFormat)
  format: AiModelFormat;

  // ── Hugging Face taxonomy + serving identity (TASK-860) ──────────────────

  @ApiProperty({
    description: 'Serving library — the Hub `library_name` facet; selects the loader.',
    enum: AI_MODEL_LIBRARIES,
    example: 'whisper.cpp',
  })
  @IsIn(AI_MODEL_LIBRARIES)
  libraryName: string;

  @ApiProperty({
    description: 'Workload that executes the model.',
    enum: AI_MODEL_SERVED_BY,
    example: 'stt',
  })
  @IsIn(AI_MODEL_SERVED_BY)
  servedBy: string;

  @ApiProperty({
    description: 'SELF_HOSTED rows have weights in the bucket; CLOUD rows carry a `wireModelId` and are NOT_APPLICABLE for availability.',
    enum: AiDeploymentKind,
    example: AiDeploymentKind.SELF_HOSTED,
  })
  @IsEnum(AiDeploymentKind)
  deploymentKind: AiDeploymentKind;

  @ApiPropertyOptional({
    description:
      'Vendor wire id a CLOUD row is invoked with (`saaras:v4`, `gpt-transcribe`, `MAI-Transcribe-1.5`). Required when `deploymentKind` is CLOUD.',
    example: 'gpt-transcribe',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  wireModelId?: string;

  @ApiPropertyOptional({ description: 'Model-card licence identifier (Hub spelling).', example: 'apache-2.0' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  license?: string;

  @ApiPropertyOptional({ description: 'Hub gated / click-through repo — the publisher needs the SYSTEM token.', example: false })
  @IsOptional()
  @IsBoolean()
  gated?: boolean;

  @ApiPropertyOptional({ description: 'Upstream base checkpoint.', example: 'openai/whisper-large-v3-turbo' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  baseModel?: string;

  @ApiPropertyOptional({ description: 'ISO 639-1 language codes, model-card order.', example: ['en', 'ml'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];

  @ApiPropertyOptional({ description: 'Hub commit sha the weights were fetched at.', example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  hfRevision?: string;

  @ApiPropertyOptional({
    description:
      'Key prefix under `s3://hope-models` when registering weights ALREADY in the bucket ("In bucket, not registered → Register"). ' +
      'Normally written by the publish job. `localPath` is derived from it and never accepted directly.',
    example: 'medical-ner/0123456789ab/',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bucketPrefix?: string;

  @ApiPropertyOptional({ description: 'The single file a single-file loader opens inside `bucketPrefix`.', example: 'ggml-model-q8_0.bin' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  primaryObject?: string;

  @ApiPropertyOptional({
    description: 'Platform-default election per task (at most one enabled row per task).',
    enum: AiTaskKind,
    isArray: true,
    example: [AiTaskKind.SPEECH_TO_TEXT],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(AiTaskKind, { each: true })
  isPlatformDefaultFor?: AiTaskKind[];

  @ApiPropertyOptional({
    description: 'Canonical runtime provider id',
    enum: AI_MODEL_PROVIDERS,
    example: 'lm-studio',
  })
  @IsOptional()
  @IsIn(AI_MODEL_PROVIDERS)
  provider?: string;

  @ApiPropertyOptional({
    description: 'Model architecture family',
    example: 'gemma4',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  architecture?: string;

  @ApiPropertyOptional({
    description: 'Estimated memory size in MB',
    example: 4096,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  memorySizeMb?: number;

  @ApiPropertyOptional({
    description: 'Compute type (float32, float16, int8)',
    example: 'float16',
  })
  @IsString()
  @IsOptional()
  computeType?: string;

  @ApiPropertyOptional({
    description: 'Tags for categorization',
    example: ['asr', 'multilingual', 'production'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
