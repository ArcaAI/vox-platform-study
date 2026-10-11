import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  GUARDRAIL_ACTIONS_TAKEN,
  GUARDRAIL_CALLERS,
  GUARDRAIL_CHECK_IDS,
  GUARDRAIL_CHECK_VERDICTS,
  GUARDRAIL_DECISIONS,
  GUARDRAIL_DIRECTIONS,
  GUARDRAIL_EVALUATION_BATCH_MAX,
  GUARDRAIL_EVALUATION_EXEMPTIONS,
  GUARDRAIL_NOTICE_ACTIONS,
  GUARDRAIL_NOTICE_MESSAGE_KEYS,
  GUARDRAIL_NOTICE_SCHEMA_VERSION,
  GUARDRAIL_NOTICE_SEVERITIES,
  GUARDRAIL_NOTICE_TYPES,
  GUARDRAIL_REGION_TRUSTS,
  type GuardrailActionTaken,
  type GuardrailCaller,
  type GuardrailCheckId,
  type GuardrailCheckVerdict,
  type GuardrailDecision,
  type GuardrailDirection,
  type GuardrailEvaluationExemption,
  type GuardrailNoticeAction,
  type GuardrailNoticeMessageKey,
  type GuardrailNoticeSeverity,
  type GuardrailNoticeType,
} from '@arcaai/types';

/**
 * TASK-1050 W2e — the validated body of `POST internal/guardrail/evaluations`, field for field the
 * frozen `GuardrailEvaluationBatchRequest` (`packages/types/src/guardrail-evaluation.ts`). Every
 * field is declared: the global pipe forbids undeclared ones.
 */
export class GuardrailEvaluationItemRefRequest {
  @ApiProperty() @IsString() @IsNotEmpty() itemId!: string;
  @ApiProperty() @IsInt() @Min(1) itemVersion!: number;
}

/** TASK-1063 5b — one flagged region of a check: keys and labels only, never text. */
export class GuardrailEvaluationFlaggedRegionRequest {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(256) key!: string;
  @ApiPropertyOptional({ enum: GUARDRAIL_REGION_TRUSTS, nullable: true })
  @IsOptional()
  @IsIn(GUARDRAIL_REGION_TRUSTS as unknown as string[])
  trust?: (typeof GUARDRAIL_REGION_TRUSTS)[number] | null;
  @ApiProperty() @IsString() @MaxLength(128) label!: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @IsNumber() @Min(0) @Max(1) score?: number | null;
}

export class GuardrailEvaluationCheckRequest {
  @ApiProperty({ enum: GUARDRAIL_CHECK_IDS }) @IsIn(GUARDRAIL_CHECK_IDS as unknown as string[]) checkId!: GuardrailCheckId;
  @ApiProperty({ enum: GUARDRAIL_CHECK_VERDICTS }) @IsIn(GUARDRAIL_CHECK_VERDICTS as unknown as string[]) verdict!: GuardrailCheckVerdict;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(1) score?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
  @ApiProperty({ enum: GUARDRAIL_ACTIONS_TAKEN }) @IsIn(GUARDRAIL_ACTIONS_TAKEN as unknown as string[]) actionTaken!: GuardrailActionTaken;
  @ApiPropertyOptional({ description: 'Machine reason code for a skipped / undetermined / recorded-as-finding check. Never text.' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
  @ApiProperty({ type: String, nullable: true }) @IsOptional() @IsString() model!: string | null;
  @ApiProperty() @IsInt() @Min(0) latencyMs!: number;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) regionKeys!: string[];
  @ApiProperty({ type: () => [GuardrailEvaluationItemRefRequest] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuardrailEvaluationItemRefRequest)
  items!: GuardrailEvaluationItemRefRequest[];
  @ApiPropertyOptional({
    type: () => [GuardrailEvaluationFlaggedRegionRequest],
    description: 'TASK-1063: per-region detail of a flag (keys and labels only).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuardrailEvaluationFlaggedRegionRequest)
  flaggedRegions?: GuardrailEvaluationFlaggedRegionRequest[];
}

export class GuardrailNoticeCheckRequest {
  @ApiProperty({ enum: GUARDRAIL_CHECK_IDS }) @IsIn(GUARDRAIL_CHECK_IDS as unknown as string[]) checkId!: GuardrailCheckId;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) category?: string;
  @ApiProperty({ enum: GUARDRAIL_NOTICE_SEVERITIES }) @IsIn(GUARDRAIL_NOTICE_SEVERITIES as unknown as string[]) severity!: GuardrailNoticeSeverity;
}

export class GuardrailNoticeRequest {
  @ApiProperty({ enum: [GUARDRAIL_NOTICE_SCHEMA_VERSION] })
  @IsIn([GUARDRAIL_NOTICE_SCHEMA_VERSION])
  schemaVersion!: typeof GUARDRAIL_NOTICE_SCHEMA_VERSION;
  @ApiProperty() @IsString() @IsNotEmpty() noticeId!: string;
  @ApiProperty({ enum: GUARDRAIL_NOTICE_TYPES }) @IsIn(GUARDRAIL_NOTICE_TYPES as unknown as string[]) type!: GuardrailNoticeType;
  @ApiProperty({ enum: GUARDRAIL_DIRECTIONS }) @IsIn(GUARDRAIL_DIRECTIONS as unknown as string[]) direction!: GuardrailDirection;
  @ApiProperty({ enum: GUARDRAIL_NOTICE_ACTIONS }) @IsIn(GUARDRAIL_NOTICE_ACTIONS as unknown as string[]) action!: GuardrailNoticeAction;
  @ApiProperty({ type: () => [GuardrailNoticeCheckRequest] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuardrailNoticeCheckRequest)
  checks!: GuardrailNoticeCheckRequest[];
  @ApiPropertyOptional() @IsOptional() @IsString() consultationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() runId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() nodeId?: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) itemIds!: string[];
  @ApiProperty({ enum: GUARDRAIL_NOTICE_MESSAGE_KEYS })
  @IsIn(GUARDRAIL_NOTICE_MESSAGE_KEYS as unknown as string[])
  messageKey!: GuardrailNoticeMessageKey;
  @ApiProperty({ description: 'The fixed label of messageKey; never stored (the gateway re-derives it).' }) @IsString() defaultMessage!: string;
  @ApiProperty() @IsBoolean() requiresAcknowledgement!: boolean;
  @ApiProperty() @IsBoolean() resumable!: boolean;
  @ApiProperty() @IsString() @IsNotEmpty() policyVersion!: string;
  @ApiProperty() @IsISO8601() occurredAt!: string;
}

export class GuardrailEvaluationRecordRequest {
  @ApiProperty({ description: 'uuidv7 minted by guardrail; the idempotency key.' }) @IsString() @IsNotEmpty() evaluationId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() tenantId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() requestId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() consultationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() runId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() runKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() nodeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() itemId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() agentSlug?: string;
  @ApiProperty({ enum: GUARDRAIL_CALLERS }) @IsIn(GUARDRAIL_CALLERS as unknown as string[]) caller!: GuardrailCaller;
  @ApiProperty({ enum: GUARDRAIL_DIRECTIONS }) @IsIn(GUARDRAIL_DIRECTIONS as unknown as string[]) direction!: GuardrailDirection;
  @ApiProperty({ enum: GUARDRAIL_DECISIONS }) @IsIn(GUARDRAIL_DECISIONS as unknown as string[]) decision!: GuardrailDecision;
  @ApiPropertyOptional({ enum: GUARDRAIL_EVALUATION_EXEMPTIONS })
  @IsOptional()
  @IsIn(GUARDRAIL_EVALUATION_EXEMPTIONS as unknown as string[])
  exempt?: GuardrailEvaluationExemption;
  @ApiProperty({ type: () => [GuardrailEvaluationCheckRequest] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuardrailEvaluationCheckRequest)
  checks!: GuardrailEvaluationCheckRequest[];
  @ApiProperty() @IsString() @IsNotEmpty() policyVersion!: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) noticeIds!: string[];
  @ApiPropertyOptional({ type: () => [GuardrailNoticeRequest] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuardrailNoticeRequest)
  notices?: GuardrailNoticeRequest[];
  @ApiPropertyOptional({ description: 'Outbound block only. Plaintext on this internal wire; encrypted before it is stored.' })
  @IsOptional()
  @IsString()
  withheldContent?: string;
  @ApiProperty() @IsISO8601() occurredAt!: string;
}

export class GuardrailEvaluationBatchRequestDto {
  @ApiProperty({ type: () => [GuardrailEvaluationRecordRequest], minItems: 1, maxItems: GUARDRAIL_EVALUATION_BATCH_MAX })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GUARDRAIL_EVALUATION_BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => GuardrailEvaluationRecordRequest)
  evaluations!: GuardrailEvaluationRecordRequest[];
}

export class GuardrailEvaluationBatchResponseDto {
  @ApiProperty({ description: 'Records stored by this call.' }) accepted!: number;
  @ApiProperty({ description: 'Records already stored (a redriven batch) or repeated within it.' }) duplicates!: number;
}
