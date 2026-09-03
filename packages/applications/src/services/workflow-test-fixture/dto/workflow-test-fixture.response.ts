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

  /**
   * Encrypted at rest with Vault Transit and therefore projected
   * ONLY on the id-scoped reads (GET /:id, and the create/update echo). List
   * pages and the delete acknowledgement omit it entirely — treat an absent
   * `input` as "not disclosed on this surface", never as "empty fixture".
   */
  @ApiPropertyOptional({
    description:
      'Synthetic test input — never real or realistic patient data. Encrypted at rest (Vault Transit); returned only by the single-fixture reads, omitted from list pages.',
  })
  input?: Record<string, unknown>;

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
