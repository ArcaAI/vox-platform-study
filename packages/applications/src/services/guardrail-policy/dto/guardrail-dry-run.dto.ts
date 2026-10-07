import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { GUARDRAIL_JUDGE_LANES } from '@arcaai/types';

/** Inline sample text cap. Sample text is synthetic platform-admin input, never a consultation. */
export const GUARDRAIL_DRY_RUN_MAX_TEXT_CHARS = 20_000;

/**
 * `POST admin/guardrail/dry-run` — run DRAFT policy values on a sample against the LIVE judge (README §11.3 B).
 * Persists nothing, loads nothing: a lane whose model is not resident is 409 `MODEL_NOT_RESIDENT` (OD-35).
 */
export class GuardrailDryRunRequest {
  @ApiProperty({ enum: GUARDRAIL_JUDGE_LANES, isArray: true, description: 'The lanes to judge the sample on.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GUARDRAIL_JUDGE_LANES.length)
  @ArrayUnique()
  @IsIn(GUARDRAIL_JUDGE_LANES as unknown as string[], { each: true })
  lanes!: string[];

  @ApiPropertyOptional({ description: 'Inline sample text. Exactly one of `text` / `sampleId`.', maxLength: GUARDRAIL_DRY_RUN_MAX_TEXT_CHARS })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(GUARDRAIL_DRY_RUN_MAX_TEXT_CHARS)
  text?: string;

  @ApiPropertyOptional({ description: 'A curated evaluation sample id (Track S-4 sets), resolved by guardrail. Exactly one of `text` / `sampleId`.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sampleId?: string;

  @ApiPropertyOptional({
    description: 'DRAFT policy values keyed by policy key (`injectionJudgeCriteria`, `judgeTemperature`, …). Each is validated exactly as a save would be; nothing is stored.',
    example: { judgeTemperature: 0 },
  })
  @IsOptional()
  @IsObject()
  policy?: Record<string, unknown>;
}

export class GuardrailDryRunLaneResult {
  @ApiProperty({ enum: GUARDRAIL_JUDGE_LANES })
  lane!: string;

  @ApiProperty({ nullable: true, type: String })
  modelId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  modelSlug!: string | null;

  @ApiProperty({ description: '`pass` | `flag` | `undetermined`. Anything guardrail did not state reads `undetermined`.' })
  verdict!: string;

  @ApiProperty({ nullable: true, type: String })
  category!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  confidence!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  latencyMs!: number | null;
}

export class GuardrailDryRunResponse {
  @ApiProperty({ type: [GuardrailDryRunLaneResult] })
  lanes!: GuardrailDryRunLaneResult[];

  @ApiProperty({ description: 'Always false: a dry run stores nothing.', example: false })
  persisted!: false;
}
