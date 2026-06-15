import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-356 Phase 6 (S3) — the per-doctor DNA writing-style on/off settings.
 *
 * `effective = tenantEnabled && (doctorToggle ?? true)` — resolved via the
 * Phase-5 pipeline-policy cascade. The UI binds the switch to `doctorToggle`
 * and disables + explains it when `tenantEnabled` is false (a doctor cannot opt
 * in when the tenant disabled DNA). `version` is the DOCTOR-scope row's OCC
 * token (0 when no override row exists yet).
 */
export class DnaSettingsResponse {
  @ApiPropertyOptional({
    description: "The doctor's explicit toggle (null = inherit / implicit opt-in).",
    nullable: true,
  })
  doctorToggle: boolean | null;

  @ApiProperty({ description: 'Whether the tenant (department/tenant/system cascade) permits DNA at all.' })
  tenantEnabled: boolean;

  @ApiProperty({ description: 'Final decision applied to generation + learning: tenant AND doctor.' })
  effective: boolean;

  @ApiProperty({ description: 'DOCTOR-scope policy row version for optimistic concurrency (0 when no row yet).', example: 0 })
  version: number;
}
