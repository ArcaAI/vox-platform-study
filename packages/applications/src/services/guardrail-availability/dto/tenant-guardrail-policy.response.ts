import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** TASK-1050 — one screening direction as it is in force. */
export class GuardrailDirectionStateResponse {
  @ApiProperty({ description: '`false` = monitor only: every check of the direction runs at `ignore` (still screened and recorded, OD-7).' })
  enabled!: boolean;
}

export class GuardrailDirectionsResponse {
  @ApiProperty({ type: GuardrailDirectionStateResponse })
  inbound!: GuardrailDirectionStateResponse;

  @ApiProperty({ type: GuardrailDirectionStateResponse })
  outbound!: GuardrailDirectionStateResponse;
}

/** TASK-1050 — one guardrail check as it is IN FORCE for the tenant (tenant → SYSTEM → catalogue, field by field). */
export class GuardrailCheckStateResponse {
  @ApiProperty({ description: 'The check id (the catalogue / `screening.py` name).' })
  checkId!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ description: 'Which screening direction(s) the check runs on.', type: [String], enum: ['inbound', 'outbound'] })
  directions!: string[];

  @ApiProperty({ description: 'Whether the check runs for this tenant.' })
  enabled!: boolean;

  @ApiProperty({ description: 'What a violation does. Read-only for a tenant admin (platform admin only).', enum: ['ignore', 'warn', 'block'] })
  action!: string;

  @ApiProperty({ description: 'The actions a platform admin may set for this check.', type: [String], enum: ['ignore', 'warn', 'block'] })
  allowedActions!: string[];

  @ApiProperty({ description: 'Locked: `enabled` cannot be changed by a tenant admin.' })
  locked!: boolean;

  @ApiPropertyOptional({
    description: '`catalogue` = always on, editable by nobody (medical validation); `platform` = a platform admin locked it; `null` = not locked.',
    enum: ['catalogue', 'platform'],
    nullable: true,
  })
  lockReason!: 'catalogue' | 'platform' | null;

  @ApiProperty({ description: 'Whether THIS caller may switch the check on/off.' })
  editable!: boolean;

  @ApiPropertyOptional({ description: 'Inbound only: what a flag on a DATA region does (platform admin only, OD-12).', enum: ['ignore', 'warn', 'block'] })
  dataRegionAction?: string;

  @ApiPropertyOptional({ description: 'Span floor in [0,1] (`pii_leak`). Platform admin only.' })
  minScore?: number;

  @ApiProperty({ description: '`true` when the tenant states no on/off for this check, so it follows the platform default.' })
  inherited!: boolean;

  @ApiPropertyOptional({ description: 'Who set the value that decides `enabled`.', enum: ['platform_admin', 'tenant_admin'], nullable: true })
  setBy!: 'platform_admin' | 'tenant_admin' | null;
}

/** TASK-1050 — `GET/PUT admin/guardrail/policy`: the caller tenant's guardrail rules. */
export class TenantGuardrailPolicyResponse {
  @ApiProperty({ description: 'The tenant these rules govern (the caller tenant, or a super admin`s working tenant).' })
  tenantId!: string;

  @ApiProperty({ description: 'Optimistic-concurrency version of the tenant row. `0` = no row yet — `If-Match: "0"` creates it.' })
  version!: number;

  @ApiProperty({ type: GuardrailDirectionsResponse })
  directions!: GuardrailDirectionsResponse;

  @ApiProperty({ type: [GuardrailCheckStateResponse], description: 'Every catalogue check, in catalogue order.' })
  checks!: GuardrailCheckStateResponse[];

  @ApiPropertyOptional({ nullable: true })
  updatedAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  updatedBy!: string | null;
}
