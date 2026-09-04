import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** @deprecated TASK-862 — removed in R3. The legacy row shape, now projected from the elected `AiRoutingPolicy` row. */
export class AiTaskDefaultResponse {
  @ApiProperty({ description: 'Owning tenant id (SYSTEM tenant = platform default row)' })
  tenantId!: string;

  @ApiProperty({ description: 'AI task key', example: 'guardrail.validate' })
  taskKey!: string;

  @ApiPropertyOptional({ description: 'Bound registry model slug. Null on the version:0 placeholder (no row yet).', nullable: true })
  modelSlug!: string | null;

  @ApiPropertyOptional({ description: 'Task-specific extras (JsonB)', nullable: true, type: Object })
  configJson?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'Resource status' })
  resourceStatus?: string;

  @ApiProperty({ description: 'OCC version. 0 when no row exists yet (create with expectedVersion=0).', example: 0 })
  version!: number;

  @ApiPropertyOptional({ description: 'Created timestamp (ISO)' })
  createdAt?: string;

  @ApiPropertyOptional({ description: 'Updated timestamp (ISO)' })
  updatedAt?: string;
}
