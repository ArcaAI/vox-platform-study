import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateTenantAllowedOriginRequest {
  /** Re-normalized via `normalizeOrigin()` when present — see `create-tenant-allowed-origin.request.ts`. */
  @ApiPropertyOptional({ description: 'Raw origin (scheme://host[:port]); re-normalized server-side when present.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  origin?: string;

  @ApiPropertyOptional({ description: 'Human-readable name for the admin list.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({ description: 'Optional operator note. Pass null to clear.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  /**
   * Optimistic-concurrency token (CAS predicate). Required — the client
   * reads the row first and echoes back the `version` it observed; the
   * service issues `updateWithVersion` and fails with
   * `OptimisticConcurrencyException` (→ 412) on drift. Mirrors
   * `UpdateDepartmentRequest.expectedVersion`.
   */
  @ApiProperty({ description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.', example: 1 })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
