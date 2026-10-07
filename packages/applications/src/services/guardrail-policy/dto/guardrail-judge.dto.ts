import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsObject, IsOptional, IsString, IsNotEmpty, Min, ValidateNested } from 'class-validator';
import { GUARDRAIL_JUDGE_CHECK_IDS } from '@arcaai/types';

/**
 * `PUT admin/guardrail/judge-models/:modelId/judge-meta` — the editable half of `_metadata.judge` (README §12.2):
 * the native-category map and the tier mapping. `protocol` and `lanes` are the model's capability
 * declaration and are NOT editable here (a capability change is a model-version change). The merged
 * declaration is validated with `judgeMetadataProblems`.
 */
export class UpdateGuardrailJudgeMetaRequest {
  @ApiPropertyOptional({
    description: 'Native category → `{ lane, category }`. Replaces the stored map when present. Unmapped native categories are ignored by guardrail.',
    example: { Jailbreak: { lane: 'injection_judge', category: 'instruction_override' } },
  })
  @IsOptional()
  @IsObject()
  categoryMap?: Record<string, { lane: string; category: string }>;

  @ApiPropertyOptional({
    description: '`{ Safe: "pass", Controversial: "pass" | "warn" | "block", Unsafe: "flag" }`. Replaces the stored tiers when present.',
    example: { Safe: 'pass', Controversial: 'warn', Unsafe: 'flag' },
  })
  @IsOptional()
  @IsObject()
  tiers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'The model row version the client read. The `If-Match` header overrides it.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class GuardrailJudgeMetaResponse {
  @ApiProperty()
  modelId!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ description: 'The model row `_version` (the ETag).' })
  version!: number;

  @ApiProperty({ description: '`_metadata.judge` after the operation.' })
  judge!: Record<string, unknown>;

  @ApiProperty({ nullable: true, description: '`_metadata.judgeDefaults` (seed-owned); `null` when the seed ships none.' })
  judgeDefaults!: Record<string, unknown> | null;

  @ApiProperty({ description: 'The current declaration equals the default.' })
  isDefault!: boolean;

  @ApiPropertyOptional({ description: 'False for an idempotent no-op.' })
  changed?: boolean;
}

/** One selectable model for a judge lane. */
export class GuardrailJudgeLaneCandidateResponse {
  @ApiProperty()
  modelId!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  @ApiProperty({ description: '`criteria_json` | `qwen3guard_native`.' })
  protocol!: string;

  @ApiProperty({ nullable: true, type: String, description: 'Which service serves it (`servedBy`).' })
  servedBy!: string | null;

  @ApiProperty({
    description: 'Residency as the model-residency controller reports it (`loaded` | `loading` | `unloading` | `not_loaded` | `unknown`). Read-only; load and unload live on `/model-residency`.',
  })
  residency!: string;
}

export class GuardrailJudgeLaneResponse {
  @ApiProperty({ enum: GUARDRAIL_JUDGE_CHECK_IDS })
  lane!: string;

  @ApiProperty({ example: 'guardrail.judge.injection' })
  taskKey!: string;

  @ApiProperty({ nullable: true, type: String, description: 'The SYSTEM `AiRoutingPolicy` row currently elected for the lane.' })
  policyId!: string | null;

  @ApiProperty({ type: GuardrailJudgeLaneCandidateResponse, nullable: true, description: 'The selected model, `null` when none is elected.' })
  selected!: GuardrailJudgeLaneCandidateResponse | null;

  @ApiProperty({ type: [GuardrailJudgeLaneCandidateResponse], description: 'Every SYSTEM model whose `_metadata.judge` declares this lane.' })
  candidates!: GuardrailJudgeLaneCandidateResponse[];
}

export class GuardrailJudgeLanesResponse {
  @ApiProperty({ type: [GuardrailJudgeLaneResponse] })
  lanes!: GuardrailJudgeLaneResponse[];
}

export class GuardrailJudgeLaneSelection {
  @ApiProperty({ enum: GUARDRAIL_JUDGE_CHECK_IDS })
  @IsIn(GUARDRAIL_JUDGE_CHECK_IDS as unknown as string[])
  lane!: string;

  @ApiProperty({ description: 'A SYSTEM `AiModel.id` whose `_metadata.judge` declares the lane (else 400 `JUDGE_LANE_UNSUPPORTED`).' })
  @IsString()
  @IsNotEmpty()
  modelId!: string;
}

/** `PUT admin/guardrail/judge-lanes` — select the model per lane. Lanes not named are left unchanged. */
export class UpdateGuardrailJudgeLanesRequest {
  @ApiProperty({ type: [GuardrailJudgeLaneSelection] })
  @ValidateNested({ each: true })
  @Type(() => GuardrailJudgeLaneSelection)
  @ArrayMinSize(1)
  @ArrayMaxSize(GUARDRAIL_JUDGE_CHECK_IDS.length)
  selections!: GuardrailJudgeLaneSelection[];
}
