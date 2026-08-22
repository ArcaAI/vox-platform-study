import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';

export class WorkflowInvariantRuleResponse {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'The SYSTEM tenant owns platform rules; any other value is a tenant addition.' })
  tenantId: string;

  @ApiProperty({ description: 'True when this row is the platform register rather than the caller tenant\'s own — read-only for a tenant admin.' })
  isSystemOwned: boolean;

  @ApiProperty()
  ruleId: string;

  @ApiProperty({ type: [String] })
  registerRefs: string[];

  @ApiProperty()
  title: string;

  @ApiPropertyOptional({ nullable: true })
  rationale: string | null;

  @ApiProperty()
  predicateType: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  predicateConfig: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true, description: 'Null applies to every palette.' })
  paletteKey: string | null;

  @ApiProperty()
  severity: string;

  @ApiProperty()
  ruleVersion: number;

  @ApiProperty()
  effectiveFrom: string;

  @ApiProperty()
  resourceStatus: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;

  @ApiProperty()
  version: number;
}

export class PaginatedWorkflowInvariantRuleResponse extends PaginatedResponse<WorkflowInvariantRuleResponse> {
  @ApiProperty({ type: [WorkflowInvariantRuleResponse] })
  override readonly data!: readonly WorkflowInvariantRuleResponse[];
}
