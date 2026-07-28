import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Upsert a tenant's STT fallback spec (the single `TenantSttConfig` row).
 *
 * `fallbackPipelineId` is the tenant-level default fallback pipeline pointer —
 * validated in the service (tenant-visible, ENABLED, cloud-engine-backed);
 * `null` clears it. `autoSwitchEnabled` toggles the error-triggered auto-switch;
 * `consecutiveFailureThreshold` tunes how many consecutive utterance failures
 * trigger it. `expectedVersion` is the OCC token: `0` = create the row (none
 * yet), `>0` = compare-and-set against the current `_version` (drift → 412). The
 * controller folds the RFC 7232 `If-Match` header over this.
 */
export class SetSttFallbackRequest {
  @ApiPropertyOptional({
    description: 'Fallback pipeline id (UUID). Must be tenant-visible, ENABLED, and cloud-engine-backed. null clears it.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  fallbackPipelineId?: string | null;

  @ApiPropertyOptional({ description: 'Enable the error-triggered auto-switch to the fallback (default true).' })
  @IsOptional()
  @IsBoolean()
  autoSwitchEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Consecutive utterance failures before an auto-switch (default 2).', example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  consecutiveFailureThreshold?: number;

  @ApiProperty({
    description: 'OCC token. 0 = create (no row yet); >0 = compare-and-set against the current version (412 on drift).',
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
