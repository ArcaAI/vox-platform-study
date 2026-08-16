import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class WorkflowTestFixtureResponse {
  @ApiProperty({ description: 'Fixture ID' })
  id!: string;

  @ApiProperty({ description: 'Fixture name' })
  name!: string;

  @ApiPropertyOptional({ description: 'Fixture description' })
  description?: string | null;

  @ApiPropertyOptional({ description: 'Palette this fixture is scoped to' })
  paletteId?: string | null;

  @ApiPropertyOptional({ description: 'WorkflowDefinition id this fixture is scoped to; null = tenant-wide' })
  workflowDefinitionId?: string | null;

  @ApiProperty({ description: 'Synthetic test input — never real or realistic patient data' })
  input!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt!: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt!: string;

  /**
   * Row version for optimistic concurrency control — same contract as
   * `DepartmentResponse.version` (rule 05 §Optimistic Concurrency).
   */
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 1,
  })
  version!: number;
}
