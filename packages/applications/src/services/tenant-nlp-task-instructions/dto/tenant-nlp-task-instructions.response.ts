import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The raw persisted TenantNlpTaskInstructions row for a (tenant, taskKey). */
export class TenantNlpTaskInstructionsResponse {
  @ApiProperty({ description: 'Owning tenant id' })
  tenantId!: string;

  @ApiProperty({ description: 'NLP instruction task key', example: 'nlp.topic' })
  taskKey!: string;

  @ApiPropertyOptional({
    description: 'Tenant-authored topic/intent label list. Null on the version:0 placeholder (no row yet).',
    nullable: true,
    type: [String],
  })
  instructionsJson!: string[] | null;

  @ApiPropertyOptional({ description: 'Resource status' })
  resourceStatus?: string;

  @ApiProperty({ description: 'OCC version. 0 when no row exists yet (create with expectedVersion=0).', example: 0 })
  version!: number;

  @ApiPropertyOptional({ description: 'Created timestamp (ISO)' })
  createdAt?: string;

  @ApiPropertyOptional({ description: 'Updated timestamp (ISO)' })
  updatedAt?: string;
}
