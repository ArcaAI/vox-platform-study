import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { GUARDRAIL_HOLD_RESOLUTIONS, type HoldResolution } from '@arcaai/types';

const CLINICIAN_DESCRIPTION =
  'The clinician the act is attributed to. REQUIRED for a machine credential (API key / service account) — a machine is never the clinician; ' +
  'a human may name another clinician only while holding SUPER_ADMIN or TENANT_ADMIN, and omits it to act as themselves.';

/** Body of `POST consultations/:id/guardrail-notices/:noticeId/ack` (If-Match on the consultation). */
export class AcknowledgeGuardrailNoticeRequest {
  @ApiPropertyOptional({ description: CLINICIAN_DESCRIPTION })
  @IsOptional()
  @IsString()
  clinicianUserId?: string;
}

/** Body of `POST consultations/:id/guardrail-hold/resume` (If-Match on the consultation). */
export class ResumeGuardrailHoldRequest {
  @ApiProperty({ description: 'The guardrail.blocked notice that holds the consultation.' })
  @IsString()
  @IsNotEmpty()
  noticeId!: string;

  @ApiProperty({
    enum: GUARDRAIL_HOLD_RESOLUTIONS,
    description:
      '`item_excluded` — leave the flagged items out of every later LLM context; `item_edited` — the clinician corrected them (a newer version is required); ' +
      '`acknowledged` — proceed once at warn weight (a SAFETY_OVERRIDE), not offered for a check whose platform floor is block.',
  })
  @IsIn(GUARDRAIL_HOLD_RESOLUTIONS as unknown as string[])
  resolution!: HoldResolution;

  @ApiPropertyOptional({ description: CLINICIAN_DESCRIPTION })
  @IsOptional()
  @IsString()
  clinicianUserId?: string;
}

/** `resolveHold` on `POST consultations/:id/approve` (TASK-1050 §9.8.3, inbound holds only). */
export class ApproveResolveHoldRequest {
  @ApiProperty({ description: 'The inbound guardrail.blocked notice the approve resolves.' })
  @IsString()
  @IsNotEmpty()
  noticeId!: string;

  @ApiProperty({ enum: GUARDRAIL_HOLD_RESOLUTIONS, description: 'Only `acknowledged` or `item_excluded` approve in one action (OD-24).' })
  @IsIn(GUARDRAIL_HOLD_RESOLUTIONS as unknown as string[])
  resolution!: HoldResolution;
}
