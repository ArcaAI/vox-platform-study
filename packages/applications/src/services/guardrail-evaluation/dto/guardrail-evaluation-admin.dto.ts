import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { GUARDRAIL_CHECK_IDS, GUARDRAIL_DECISIONS, GUARDRAIL_DIRECTIONS } from '@arcaai/types';
import { MAX_CURSOR_LIMIT } from '../../../common/cursorPagination';

/** Query of `GET admin/consultations/:id/guardrail-evaluations` (keyset, newest first). */
export class GuardrailEvaluationListQuery {
  @ApiPropertyOptional({ description: 'The `nextCursor` of the previous page.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_CURSOR_LIMIT, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CURSOR_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ enum: GUARDRAIL_DECISIONS, description: 'The evaluation`s decision.' })
  @IsOptional()
  @IsIn(GUARDRAIL_DECISIONS as unknown as string[])
  action?: string;

  @ApiPropertyOptional({ enum: GUARDRAIL_DIRECTIONS })
  @IsOptional()
  @IsIn(GUARDRAIL_DIRECTIONS as unknown as string[])
  direction?: string;

  @ApiPropertyOptional({ enum: GUARDRAIL_CHECK_IDS, description: 'Only evaluations that ran this check.' })
  @IsOptional()
  @IsIn(GUARDRAIL_CHECK_IDS as unknown as string[])
  check?: string;

  @ApiPropertyOptional({ description: 'Only the evaluations of this workflow run.' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  runId?: string;

  @ApiPropertyOptional({ description: 'Only the evaluations of this AI activity run (`AiActivityRun.runKey`).' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  runKey?: string;
}

export class GuardrailEvaluationItemRefResponse {
  @ApiProperty() itemId!: string;
  @ApiProperty() itemVersion!: number;
}

export class GuardrailEvaluationCheckResponse {
  @ApiProperty({ enum: GUARDRAIL_CHECK_IDS }) checkId!: string;
  @ApiProperty({ enum: ['pass', 'flag', 'undetermined', 'skipped'] }) verdict!: string;
  @ApiPropertyOptional() score?: number;
  @ApiPropertyOptional() category?: string;
  @ApiPropertyOptional() confidence?: number;
  @ApiProperty({ enum: ['none', 'ignore', 'warn', 'block', 'unverified'] }) actionTaken!: string;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
  @ApiProperty() latencyMs!: number;
  @ApiProperty({ type: [String] }) regionKeys!: string[];
  @ApiProperty({ type: () => [GuardrailEvaluationItemRefResponse] }) items!: GuardrailEvaluationItemRefResponse[];
}

/** One evaluation row of the admin grid. No content and no judge reasoning. */
export class GuardrailEvaluationRowResponse {
  @ApiProperty() evaluationId!: string;
  @ApiProperty({ description: 'When guardrail decided (ISO-8601).' }) at!: string;
  @ApiProperty() requestId!: string;
  @ApiProperty({ type: String, nullable: true }) consultationId!: string | null;
  @ApiProperty({ type: String, nullable: true }) runId!: string | null;
  @ApiProperty({ type: String, nullable: true }) runKey!: string | null;
  @ApiProperty({ type: String, nullable: true }) nodeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) agentSlug!: string | null;
  @ApiProperty() caller!: string;
  @ApiProperty({ enum: GUARDRAIL_DIRECTIONS }) direction!: 'inbound' | 'outbound';
  @ApiProperty({ enum: GUARDRAIL_DECISIONS }) decision!: 'allow' | 'warn' | 'block' | 'unverified';
  @ApiProperty({ type: String, nullable: true }) exempt!: string | null;
  @ApiProperty() policyVersion!: string;
  @ApiProperty({ type: [String] }) noticeIds!: string[];
  @ApiProperty({ type: () => [GuardrailEvaluationCheckResponse] }) checks!: GuardrailEvaluationCheckResponse[];
  @ApiProperty({ description: 'An outbound block whose output was withheld (read it through the withheld review route).' }) hasWithheldContent!: boolean;
}

export class GuardrailEvaluationPageResponse {
  @ApiProperty() consultationId!: string;
  @ApiProperty({ type: () => [GuardrailEvaluationRowResponse] }) items!: GuardrailEvaluationRowResponse[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
  @ApiProperty() limit!: number;
}

/** The decrypted output an outbound block withheld (PHI; Prompt Inspector audience only, audited). */
export class GuardrailWithheldContentResponse {
  @ApiProperty() evaluationId!: string;
  @ApiProperty() consultationId!: string;
  @ApiProperty() at!: string;
  @ApiProperty() policyVersion!: string;
  @ApiProperty({ type: [String] }) noticeIds!: string[];
  @ApiProperty({ description: 'The withheld generation, decrypted.' }) content!: string;
}
