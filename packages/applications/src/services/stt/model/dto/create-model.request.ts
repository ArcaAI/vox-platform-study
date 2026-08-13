import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsArray, IsEnum, IsIn, IsNumber, Matches, MaxLength, MinLength, Min } from 'class-validator';
import { ModelCategory, ModelTaskType, ModelType, AiModelSource, AiModelFormat } from '@arcaai/domains';

/**
 * Canonical runtime provider ids for registry rows.
 *
 * This list MUST stay identical to the seed's canonical list in
 * `packages/database/src/prisma/db_main/seed/ai-models/shared.ts` — it drifted
 * (missing `vllm`/`llama-cpp`), so a seeded or discovered vLLM/llama.cpp model
 * could not be written through the API at all. Pinned by
 * `tests/contracts/ai-model-providers.contract.test.ts`.
 */
export const AI_MODEL_PROVIDERS = [
  'ollama',
  'lm-studio',
  'azure',
  'bedrock',
  'built-in',
  'sarvam',
  'openai',
  // Cloud tenant-BYO LLM providers — mirrors the seed addition.
  'anthropic',
  'vertex',
  'vllm',
  'llama-cpp',
] as const;

/**
 * The subset of providers whose models live on a server we can
 * ENUMERATE (`admin/ai-models/discovery`). Cloud providers have nothing to
 * "discover", so the register action refuses them.
 */
export const DISCOVERABLE_AI_MODEL_PROVIDERS = ['ollama', 'lm-studio', 'vllm', 'llama-cpp'] as const;

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
    description: 'Model task type',
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
    description: 'Model format',
    enum: AiModelFormat,
    example: AiModelFormat.SAFETENSOR,
  })
  @IsEnum(AiModelFormat)
  format: AiModelFormat;

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
