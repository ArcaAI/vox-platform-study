import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DepartmentAgentDnaPolicy, ResourceStatusType } from '@arcaai/domains';
import { PaginatedResponse } from '../../../common';

export class DepartmentAgentResponse {
  @ApiProperty({ description: 'Agent id' })
  id: string;

  @ApiProperty({ description: 'Department id' })
  departmentId: string;

  @ApiProperty({ description: 'Agent name' })
  name: string;

  @ApiProperty({ description: 'Slug (unique per department)' })
  slug: string;

  @ApiPropertyOptional({ description: 'Description' })
  description?: string;

  @ApiProperty({ description: 'Bound PromptTemplate id' })
  promptTemplateId: string;

  @ApiPropertyOptional({ description: 'Pinned PromptVersion number (null ⇒ tracks latest APPROVED)', nullable: true })
  pinnedVersionNumber?: number | null;

  @ApiProperty({ description: 'DNA writing-style gate', enum: DepartmentAgentDnaPolicy })
  dnaStylePolicy: DepartmentAgentDnaPolicy;

  @ApiPropertyOptional({ description: 'Tenant-tier HarnessPolicy overrides' })
  harnessOverrides?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Golden set id' })
  goldenSetId?: string;

  @ApiProperty({ description: 'Whether this is the department default agent' })
  isDefault: boolean;

  @ApiPropertyOptional({ description: 'Template lineage — the agent-template slug this row descends from', nullable: true })
  sourceAgentTemplateSlug?: string | null;

  @ApiProperty({ description: 'Whether this is a locked template copy (read-only content; clone to customize)' })
  templateLocked: boolean;

  @ApiPropertyOptional({ description: 'Tags', type: [String] })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Creation timestamp (ISO)' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp (ISO)' })
  updatedAt: string;

  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 1,
  })
  version!: number;
}

export class PaginatedDepartmentAgentResponse extends PaginatedResponse<DepartmentAgentResponse> {
  @ApiProperty({ type: [DepartmentAgentResponse] })
  override readonly data!: readonly DepartmentAgentResponse[];
}
