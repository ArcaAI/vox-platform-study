import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateTenantAllowedOriginRequest {
  /**
   * Re-normalized when present, routed by shape exactly like
   * `CreateTenantAllowedOriginRequest.origin` — see that DTO for the full
   * contract (exact origin / wildcard pattern / bare `*`).
   */
  @ApiPropertyOptional({
    description:
      'Raw origin, re-normalized server-side when present. Accepts an EXACT origin (scheme://host[:port]), a wildcard PATTERN (scheme://*.suffix:*), or the bare allow-all token `*`.',
    examples: {
      exact: 'https://arcaai-staging.bcmch.org',
      pattern: 'https://*.bcmch.org:*',
      allowAll: '*',
    },
  })
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
