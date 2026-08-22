import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkflowRulePredicateType, WorkflowRuleSeverity } from '@arcaai/domains';
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/**
 * Author one `WorkflowInvariantRule` row (TASK-790 W3b).
 *
 * NOTE the absence of `tenantId`: the row's owner is the CALLER's tenant, read from CLS, never
 * accepted from the body (rule 05 §S-3). The global pipe runs `forbidNonWhitelisted`, so a body
 * carrying `tenantId` is rejected outright rather than silently ignored.
 */
export class CreateWorkflowInvariantRuleRequest {
  @ApiProperty({ description: 'Stable human id, e.g. "WF-I-006" — parity with contracts/rule-model.md.', example: 'WF-I-900' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9-]{3,48}$/, { message: 'ruleId must match /^[A-Z0-9-]{3,48}$/' })
  ruleId: string;

  @ApiProperty({ example: 'Every consultation graph must hop PHI' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ description: 'Why the rule exists — shown beside a finding.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  rationale?: string;

  @ApiPropertyOptional({ description: 'INV ids from the invariant register this rule makes executable.', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  registerRefs?: string[];

  @ApiProperty({ enum: WorkflowRulePredicateType, description: 'The code-owned predicate KIND. Adding a new kind is a deploy; this row is one parameterization of an existing one.' })
  @IsEnum(WorkflowRulePredicateType)
  predicateType: WorkflowRulePredicateType;

  @ApiProperty({ type: 'object', additionalProperties: true, description: "Validated against the predicate's own configProblems() at evaluation time." })
  @IsObject()
  predicateConfig: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true, description: 'Null applies the rule to every palette (the structural class). Otherwise a registry-declared palette key.', example: 'consultation' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  paletteKey?: string;

  @ApiPropertyOptional({ enum: WorkflowRuleSeverity, description: 'Defaults to ERROR — a rule that silently defaulted to WARNING would be authored as a gate and behave as advice.' })
  @IsOptional()
  @IsEnum(WorkflowRuleSeverity)
  severity?: WorkflowRuleSeverity;

  @ApiPropertyOptional({ description: 'Bumping this is what the re-validation sweep keys off. A predicateConfig change MUST bump it.', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  ruleVersion?: number;
}
