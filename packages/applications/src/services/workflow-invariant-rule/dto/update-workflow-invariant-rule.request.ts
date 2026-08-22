import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkflowRuleSeverity } from '@arcaai/domains';
import { IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * A versioned PATCH of a rule row (TASK-790 W3b).
 *
 * `ruleId`, `predicateType` and `paletteKey` are deliberately absent: changing any of them makes
 * the row a DIFFERENT rule, which is an insert, not an edit — and silently re-pointing a ruleId
 * would let a tenant row start shadowing a SYSTEM rule it was never authored against.
 */
export class UpdateWorkflowInvariantRuleRequest {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  rationale?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  predicateConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: WorkflowRuleSeverity })
  @IsOptional()
  @IsEnum(WorkflowRuleSeverity)
  severity?: WorkflowRuleSeverity;

  @ApiPropertyOptional({ description: 'Bump when predicateConfig changes, or published definitions silently keep an old verdict.', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  ruleVersion?: number;

  @ApiProperty({ description: 'OCC precondition — comes from the If-Match header (@ExpectedVersion), which overrides this field.' })
  @IsInt()
  expectedVersion: number;
}
