import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsOptional, IsArray, IsBoolean, IsEnum, IsIn, IsNumber, IsInt, Matches, MaxLength, MinLength, Min, ValidateNested } from 'class-validator';
import { AiDeploymentKind, ModelCategory, ModelTaskType, ModelType, AiModelSource, AiModelFormat } from '@arcaai/domains';
import { AI_MODEL_LIBRARIES, AI_MODEL_PROVIDERS, AI_MODEL_SERVED_BY } from '../constants';
import { AsrProfileRequest } from './asr-profile.request';

/**
 * `PATCH admin/ai-models/:id`.
 *
 * `localPath` is NOT accepted (TASK-860 D-2): it is derived from
 * `bucketPrefix` (+ `primaryObject`) by the service, so the global
 * `forbidNonWhitelisted` pipe rejects a body that carries it. The
 * platform-default election has its own route (`PATCH :id/platform-default`)
 * because it also clears the previous holder — it is not a field edit.
 */
export class UpdateModelRequest {
  @ApiPropertyOptional({
    description: 'Model name',
    example: 'Whisper Large V3 Updated',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'URL-friendly unique identifier',
    example: 'whisper-large-v3',
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({
    description: 'Model description',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Model category',
    enum: ModelCategory,
  })
  @IsEnum(ModelCategory)
  @IsOptional()
  category?: ModelCategory;

  @ApiPropertyOptional({
    description: 'Hugging Face task (`pipeline_tag`) as the SCREAMING_CASE enum member.',
    enum: ModelTaskType,
  })
  @IsEnum(ModelTaskType)
  @IsOptional()
  taskType?: ModelTaskType;

  @ApiPropertyOptional({
    description: 'Model type',
    enum: ModelType,
  })
  @IsEnum(ModelType)
  @IsOptional()
  modelType?: ModelType;

  @ApiPropertyOptional({
    description: 'Model source. S3 = S3/MinIO-compatible object storage (s3:// only; azure-blob:// is out of scope).',
    enum: AiModelSource,
  })
  @IsEnum(AiModelSource)
  @IsOptional()
  source?: AiModelSource;

  @ApiPropertyOptional({
    description:
      'Source URI. Scheme grammar honoured by every service resolver: ' +
      '`hf:<org>/<repo>` or a bare HuggingFace id (Hub snapshot, honours HF_HUB_OFFLINE) · ' +
      '`file:///abs/path` (verified in place, never copied) · ' +
      '`s3://bucket/prefix` (downloaded once into the service cache, single-flight + SHA256-verified). ' +
      'Any other scheme is rejected — there is no silent fallback.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  sourceUri?: string;

  @ApiPropertyOptional({
    description:
      'SHA256 checksum. When set, single-file artifacts (GGUF/ONNX) are verified after download and on ' +
      'first use of a pre-existing cache entry; a mismatch is a HARD error and the model is never served. ' +
      'On directory snapshots (HuggingFace) it is a documented no-op.',
    example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  })
  @IsString()
  @IsOptional()
  @MaxLength(128)
  checksum?: string;

  @ApiPropertyOptional({
    description: 'Source revision',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  sourceRevision?: string;

  @ApiPropertyOptional({
    description: 'Artifact format (descriptive; loader selection is `libraryName`).',
    enum: AiModelFormat,
  })
  @IsEnum(AiModelFormat)
  @IsOptional()
  format?: AiModelFormat;

  // ── Hugging Face taxonomy + serving identity (TASK-860) ──────────────────

  @ApiPropertyOptional({ description: 'Serving library — the Hub `library_name` facet.', enum: AI_MODEL_LIBRARIES })
  @IsOptional()
  @IsIn(AI_MODEL_LIBRARIES)
  libraryName?: string;

  @ApiPropertyOptional({ description: 'Workload that executes the model.', enum: AI_MODEL_SERVED_BY })
  @IsOptional()
  @IsIn(AI_MODEL_SERVED_BY)
  servedBy?: string;

  @ApiPropertyOptional({ description: 'SELF_HOSTED or CLOUD.', enum: AiDeploymentKind })
  @IsOptional()
  @IsEnum(AiDeploymentKind)
  deploymentKind?: AiDeploymentKind;

  @ApiPropertyOptional({ description: 'Vendor wire id for a CLOUD row. Send an empty string to clear.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  wireModelId?: string;

  @ApiPropertyOptional({ description: 'Model-card licence identifier. Send an empty string to clear.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  license?: string;

  @ApiPropertyOptional({ description: 'Hub gated / click-through repo.' })
  @IsOptional()
  @IsBoolean()
  gated?: boolean;

  @ApiPropertyOptional({ description: 'Upstream base checkpoint. Send an empty string to clear.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  baseModel?: string;

  @ApiPropertyOptional({ description: 'ISO 639-1 language codes, model-card order.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];

  @ApiPropertyOptional({ description: 'Hub commit sha. Send an empty string to clear.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  hfRevision?: string;

  @ApiPropertyOptional({
    description:
      'Key prefix under `s3://hope-models`. Normally written by the publish job; accepted here for "register from bucket". ' +
      '`localPath` is derived from it (+ `primaryObject`). Send an empty string to clear both.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bucketPrefix?: string;

  @ApiPropertyOptional({ description: 'The single file a single-file loader opens inside `bucketPrefix`. Send an empty string to clear.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  primaryObject?: string;

  @ApiPropertyOptional({
    description: 'Canonical runtime provider id',
    enum: AI_MODEL_PROVIDERS,
  })
  @IsOptional()
  @IsIn(AI_MODEL_PROVIDERS)
  provider?: string;

  @ApiPropertyOptional({
    description: 'Model architecture family',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  architecture?: string;

  @ApiPropertyOptional({
    description: 'Estimated memory size in MB',
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  memorySizeMb?: number;

  @ApiPropertyOptional({
    description: 'Compute type',
  })
  @IsString()
  @IsOptional()
  computeType?: string;

  @ApiPropertyOptional({
    description: 'Tags for categorization',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({
    description:
      'Decode profile for an `AUTOMATIC_SPEECH_RECOGNITION` row (`_metadata.asr`, TASK-934) — window geometry, decode ' +
      "thresholds and the priming prompt this fine-tune was measured with. 400 on any other row's `taskType`. Send " +
      '`null` to clear the stored profile without touching any other `_metadata` key; omit the field to leave it untouched.',
    type: AsrProfileRequest,
    nullable: true,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AsrProfileRequest)
  asrProfile?: AsrProfileRequest | null;

  // OCC CAS predicate (echoed from the prior GET, e.g. via
  // the `ETag` header). The controller folds the `If-Match` header over this
  // when both are present; missing both yields `428 Precondition Required` on
  // `@RequiresIfMatch()` routes. Mirrors `UpdatePipelineRequest.expectedVersion`.
  @ApiProperty({
    description:
      'Current version of the row (from the prior GET, e.g. via the `ETag` header). The PATCH fails with `412 Precondition Failed` if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
