import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { ModelTaskType } from '@arcaai/domains';

/** Capability flags an authoring form reads off a declared model (`_metadata.capabilities`). */
export class DeclaredModelCapabilitiesDto {
  @ApiPropertyOptional({
    description: 'Generation parameters this deployment honours. Only what `apps/text` can actually deliver reaches a provider.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(32)
  supportedGenerationParams?: string[];

  @ApiPropertyOptional({ description: 'Whether the deployment accepts SSML (speech models).' })
  @IsOptional()
  @IsBoolean()
  supportsSsml?: boolean;
}

/** ONE model a tenant's connection serves. */
export class DeclaredConnectionModelDto {
  @ApiProperty({
    description:
      'The provider-native model id that goes ON THE WIRE — an Azure DEPLOYMENT name, an OpenAI/Anthropic model id. ' +
      'It is also the row locator: for a vendor model the two are the same string.',
    example: 'gpt-4o-mini',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  wireModelId!: string;

  @ApiProperty({ description: 'Display name shown in pickers.', example: 'GPT-4o mini (production)' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ description: 'What this model does. Must be a task the connection service governs.', enum: ModelTaskType })
  @IsEnum(ModelTaskType)
  taskType!: ModelTaskType;

  @ApiPropertyOptional({ description: 'Capability flags for authoring forms.', type: DeclaredModelCapabilitiesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeclaredModelCapabilitiesDto)
  capabilities?: DeclaredModelCapabilitiesDto;

  @ApiPropertyOptional({
    description:
      'Override the SERVER-GENERATED slug. Supply this ONLY to accept the `suggestedSlug` a `BYO_SLUG_SHADOWS_PLATFORM` ' +
      'conflict offered; otherwise leave it out and let the server name the row.',
    example: 'byo-azure-gpt-4o-mini',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  slug?: string;
}

/**
 * `PUT admin/providers/:service/:provider/models` — the WHOLE list a tenant's
 * connection serves.
 *
 * A full REPLACEMENT on purpose: the console edits a list, and a PATCH-shaped
 * "add one / remove one" API would leave the rows and the tenant's mental model
 * able to disagree. An entry that leaves the list is soft-deleted; an agent
 * still bound to it keeps its foreign key and fails its NEXT publish with a
 * named reason, which is observable — unlike a silently vanished binding.
 */
export class DeclareConnectionModelsRequest {
  @ApiProperty({ description: 'Every model this connection serves. An empty array withdraws them all.', type: [DeclaredConnectionModelDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DeclaredConnectionModelDto)
  models!: DeclaredConnectionModelDto[];
}
