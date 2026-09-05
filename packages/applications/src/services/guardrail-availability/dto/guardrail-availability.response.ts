import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GuardrailAvailabilityResponse {
  @ApiProperty({ description: 'The tenant this availability row governs.' })
  tenantId!: string;

  @ApiProperty({
    description:
      'Optimistic-concurrency version. `0` means the tenant has NO row yet — send `If-Match: "0"` to create one. A tenant with no row inherits the SYSTEM set.',
  })
  version!: number;

  @ApiProperty({
    description:
      "This tenant's OWN selection, keyed by policy id (`{}` when it has none). An empty — or all-disabled — selection is NOT an off switch: it inherits the SYSTEM set.",
    type: 'object',
    additionalProperties: true,
  })
  policies!: Record<string, unknown>;

  @ApiProperty({
    description: 'What ACTUALLY applies to this tenant after the two-tier `request tenant → SYSTEM` cascade.',
    type: 'object',
    additionalProperties: true,
  })
  effective!: Record<string, unknown>;

  @ApiProperty({
    description:
      'WHICH tier supplied `effective` — this tenant, or the reserved SYSTEM tenant `00000000-…`. Every screening decision records the same value so a verdict stays attributable.',
  })
  effectiveSourceTenantId!: string;

  @ApiPropertyOptional({ description: 'Why this tenant\'s set differs from the platform default.', nullable: true })
  reason!: string | null;

  @ApiPropertyOptional({ description: 'ISO timestamp of the last write, or null when no row exists.', nullable: true })
  updatedAt!: string | null;

  @ApiPropertyOptional({ description: 'Id of the platform admin who last wrote this row.', nullable: true })
  updatedBy!: string | null;
}

export class GuardrailPolicyCatalogueEntryResponse {
  @ApiProperty({ description: 'The check name, as declared in `screening.py`.' })
  id!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ description: 'Which screening direction(s) the check runs on.', type: [String] })
  directions!: string[];

  @ApiPropertyOptional({
    description: 'The strictness field this policy accepts, and which direction TIGHTENS it. Absent ⇒ the policy is on/off only.',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  threshold!: Record<string, unknown> | null;
}
