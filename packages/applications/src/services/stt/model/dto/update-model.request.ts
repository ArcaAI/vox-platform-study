import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, IsEnum, IsIn, IsNumber, IsInt, Matches, MaxLength, MinLength, Min } from 'class-validator';
import { ModelCategory, ModelTaskType, ModelType, AiModelSource, AiModelFormat } from '@arcaai/domains';
import { AI_MODEL_PROVIDERS } from './create-model.request';

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
    description: 'Model task type',
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
    description: 'Model source. S3 = S3/MinIO-compatible object storage (OD-4: s3:// only; azure-blob:// is out of scope).',
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

  // TASK-527 (D-12) — the operator override. Previously unwritable through this
  // DTO, so the global `forbidNonWhitelisted` pipe rejected any PATCH carrying
  // it and the registry row could never point at a staged weight directory.
  @ApiPropertyOptional({
    description:
      'Operator/admin override for the weight directory — HIGHEST precedence in every service resolver, ' +
      'ahead of `sourceUri` scheme dispatch. Use for air-gapped hosts and pre-staged NFS mounts. ' +
      'A set-but-missing path falls THROUGH to scheme dispatch with a warning (never a hard failure). ' +
      'Send an empty string to clear the override.',
    example: '/opt/hope/models/minicheck-flan-t5-large',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  localPath?: string;

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
    description: 'Model format',
    enum: AiModelFormat,
  })
  @IsEnum(AiModelFormat)
  @IsOptional()
  format?: AiModelFormat;

  @ApiPropertyOptional({
    description: 'Canonical runtime provider id (TASK-506)',
    enum: AI_MODEL_PROVIDERS,
  })
  @IsOptional()
  @IsIn(AI_MODEL_PROVIDERS)
  provider?: string;

  @ApiPropertyOptional({
    description: 'Model architecture family (TASK-506)',
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

  // TASK-356 Phase 1 — OCC CAS predicate (echoed from the prior GET, e.g. via
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
