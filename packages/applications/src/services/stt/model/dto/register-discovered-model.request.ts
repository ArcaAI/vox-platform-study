import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DISCOVERABLE_AI_MODEL_PROVIDERS } from './create-model.request';

/**
 * Body of `POST admin/ai-models/discovery/register`.
 *
 * Turns ONE entry the live engine listing reported into a governed `AiModel`
 * row. Only the two identifying fields are required; everything else on the
 * created row (category / taskType / modelType / source / format) is derived
 * from the provider, because a discovered entry is by construction a
 * server-managed text-generation model.
 *
 * `slug` stays optional and is normally derived from `modelName`. It becomes
 * REQUIRED only when the derived slug is already taken — deliberately no silent
 * suffixing, so governance rows are always named on purpose.
 */
export class RegisterDiscoveredModelRequest {
  @ApiProperty({
    description: 'Server-managed provider the model was discovered on (SMR registry key).',
    enum: DISCOVERABLE_AI_MODEL_PROVIDERS,
    example: 'ollama',
  })
  @IsIn(DISCOVERABLE_AI_MODEL_PROVIDERS)
  provider: string;

  @ApiProperty({
    description: 'Model name exactly as the engine reports it. Stored verbatim as `sourceUri`.',
    example: 'llama3.1:8b-instruct-q4_K_M',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  modelName: string;

  @ApiPropertyOptional({
    description: 'Explicit slug. Required only when the slug derived from `modelName` is already taken.',
    example: 'llama3-1-8b-instruct-q4-k-m',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({
    description: 'Display name. Defaults to `modelName`.',
    example: 'Llama 3.1 8B Instruct',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'Free-text description for the registry row.',
    example: 'Discovered on the local Ollama server.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
