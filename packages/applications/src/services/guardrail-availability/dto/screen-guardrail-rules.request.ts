import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';

/**
 * The most text one playground screen may carry, per field. Guardrail windows long input itself, so
 * this is a request-size bound for an interactive tool, not a screening limit.
 */
export const GUARDRAIL_SCREEN_TEXT_MAX = 20_000;
export const GUARDRAIL_SCREEN_REGIONS_MAX = 32;

export class GuardrailScreenRegionRequest {
  @ApiProperty({ description: 'Region key (an `EXTERNAL_DATA` section name, or `user` / `system`).', example: 'transcript' })
  @IsString()
  @Matches(/^[a-z0-9_]{1,64}$/)
  key!: string;

  @ApiProperty({ description: 'The region text.', maxLength: GUARDRAIL_SCREEN_TEXT_MAX })
  @IsString()
  @MaxLength(GUARDRAIL_SCREEN_TEXT_MAX)
  text!: string;

  @ApiProperty({ description: '`instruction` decides; `data` is clinical content (inbound only).', enum: ['instruction', 'data'] })
  @IsIn(['instruction', 'data'])
  trust!: 'instruction' | 'data';
}

/** `POST admin/guardrail/screen` — the playground's "Test my rules". Exactly one of `text` / `regions`. */
export class ScreenGuardrailRulesRequest {
  @ApiProperty({ description: '`inbound` screens a request; `outbound` screens a response.', enum: ['inbound', 'outbound'] })
  @IsIn(['inbound', 'outbound'])
  direction!: 'inbound' | 'outbound';

  @ApiProperty({
    description: 'Inbound: the content to screen (empty when `regions` is given). Outbound: the response to screen.',
    maxLength: GUARDRAIL_SCREEN_TEXT_MAX,
  })
  @IsString()
  @MinLength(0)
  @MaxLength(GUARDRAIL_SCREEN_TEXT_MAX)
  text!: string;

  @ApiPropertyOptional({
    description: 'Inbound: the content as regions (then `text` must be empty). Outbound: the source regions the response is checked against.',
    type: [GuardrailScreenRegionRequest],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(GUARDRAIL_SCREEN_REGIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => GuardrailScreenRegionRequest)
  regions?: GuardrailScreenRegionRequest[];
}
