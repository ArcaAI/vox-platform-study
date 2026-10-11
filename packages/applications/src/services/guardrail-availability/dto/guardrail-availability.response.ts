import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GuardrailCheckStateResponse, GuardrailDirectionsResponse } from './tenant-guardrail-policy.response';

/** TASK-1050 — the v2 policy in force: per direction and per check, field by field (tenant → SYSTEM → catalogue). */
export class GuardrailEffectivePolicyResponse {
  @ApiProperty({ type: GuardrailDirectionsResponse })
  directions!: GuardrailDirectionsResponse;

  @ApiProperty({ type: [GuardrailCheckStateResponse] })
  checks!: GuardrailCheckStateResponse[];
}

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
    description:
      'What ACTUALLY applies to this tenant, in the legacy flat shape `{ <checkId>: { enabled, minScore? } }` (every catalogue check). Read `effectivePolicy` for actions, locks and directions.',
    type: 'object',
    additionalProperties: true,
  })
  effective!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'the v2 policy in force, field by field (platform default → SYSTEM row → tenant row), as guardrail resolves it.',
    type: GuardrailEffectivePolicyResponse,
  })
  effectivePolicy?: GuardrailEffectivePolicyResponse;

  @ApiProperty({
    description:
      'WHICH tier supplied `effective` — this tenant, or the reserved SYSTEM tenant `00000000-…`. Every screening decision records the same value so a verdict stays attributable.',
  })
  effectiveSourceTenantId!: string;

  @ApiPropertyOptional({ description: "Why this tenant's set differs from the platform default.", nullable: true })
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

  @ApiProperty({ description: 'the actions a platform admin may set.', type: [String], enum: ['ignore', 'warn', 'block'] })
  allowedActions!: string[];

  @ApiProperty({ description: 'the action when no tier sets one.', enum: ['ignore', 'warn', 'block'] })
  platformDefaultAction!: string;

  @ApiProperty({ description: 'catalogue lock: always on at its default action, editable by nobody.' })
  locked!: boolean;

  @ApiProperty({ description: 'the platform default on/off.' })
  defaultEnabled!: boolean;

  @ApiPropertyOptional({ description: 'inbound DATA-region action default (OD-12); null where it does not apply.', nullable: true })
  platformDefaultDataRegionAction!: string | null;

  @ApiPropertyOptional({
    description: 'The catalogue\'s per-category action overrides (`{ label: action }`); absent where none.',
    type: 'object',
    additionalProperties: { type: 'string', enum: ['ignore', 'warn', 'block'] },
  })
  platformDefaultCategoryActions?: Record<string, string>;
}
