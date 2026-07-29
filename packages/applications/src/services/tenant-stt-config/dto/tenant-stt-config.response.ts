import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The raw persisted STT config row for a tenant (unresolved). */
export class TenantSttConfigResponse {
  @ApiProperty({ description: 'Owning tenant id' })
  tenantId!: string;

  @ApiPropertyOptional({ description: 'Tenant-level default fallback pipeline id', nullable: true })
  fallbackPipelineId?: string | null;

  @ApiProperty({ description: 'Whether the error-triggered auto-switch is enabled' })
  autoSwitchEnabled!: boolean;

  @ApiPropertyOptional({ description: 'Consecutive utterance failures before an auto-switch', nullable: true })
  consecutiveFailureThreshold?: number | null;

  @ApiPropertyOptional({ description: 'Persisted config extras (forward-compat)', nullable: true, type: Object })
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
