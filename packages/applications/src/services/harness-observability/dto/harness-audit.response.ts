import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HarnessAuditAction, JsonValue } from '@arcaai/domains';

/**
 * One WORM audit row — read projection of `HarnessAuditEvent`.
 * Append-only + hash-chained; `prevHash`/`hash` expose the tamper-evident chain
 * so the console can show the verification badge.
 */
export class HarnessAuditEventResponse {
  @ApiProperty({ description: 'Audit event id (time-sortable UUIDv7; ordering reflects append order).' })
  id: string;

  @ApiProperty({ description: 'Owning tenant id.' })
  tenantId: string;

  @ApiPropertyOptional({
    description: 'Consultation the event belongs to (null for CONSENT_GIVEN/CONSENT_WITHDRAWN, which have no consultation).',
    nullable: true,
  })
  consultationId: string | null;

  @ApiPropertyOptional({ description: 'Context-item version the event references (null when not applicable).', nullable: true })
  contextItemVersionId: string | null;

  @ApiProperty({ description: 'Audit action.', enum: HarnessAuditAction })
  action: HarnessAuditAction;

  @ApiProperty({ description: 'Generating model name.' })
  modelName: string;

  @ApiProperty({ description: 'Generating model version.' })
  modelVersion: string;

  @ApiPropertyOptional({ description: 'Prompt template id (null when not applicable).', nullable: true })
  promptTemplateId: string | null;

  @ApiPropertyOptional({ description: 'Prompt version (null when not applicable).', nullable: true })
  promptVersion: string | null;

  @ApiProperty({ description: 'Sensor scores recorded for the event (free-form JSON).' })
  sensorScores: JsonValue;

  @ApiProperty({ description: 'Citations recorded for the event (free-form JSON).' })
  citations: JsonValue;

  @ApiPropertyOptional({ description: 'Gate decision (e.g. APPROVE/REJECT) when this is a GATE_DECISION event.', nullable: true })
  gateDecision: string | null;

  @ApiPropertyOptional({ description: 'Attesting clinician id (null when not a clinician action).', nullable: true })
  clinicianId: string | null;

  @ApiPropertyOptional({ description: 'Attestation hash captured at sign-off (null when not applicable).', nullable: true })
  attestationHash: string | null;

  @ApiProperty({ description: 'Previous event hash (chain linkage; genesis = 64 zeros for the first event).' })
  prevHash: string;

  @ApiProperty({ description: 'This event hash (SHA-256 over the canonical fields).' })
  hash: string;

  @ApiProperty({ description: 'Append timestamp (ISO-8601).' })
  createdAt: string;

  @ApiPropertyOptional({ description: 'Actor that appended the event (null for system writes).', nullable: true })
  createdBy: string | null;
}

/** Hash-chain verification verdict for the tenant's full audit chain. */
export class HarnessAuditVerificationResponse {
  @ApiProperty({ description: 'Whether the full chain re-verified (hash + prevHash linkage intact).', example: true })
  valid: boolean;

  @ApiPropertyOptional({ description: 'Index of the first event that breaks the chain, or null when valid.', nullable: true })
  brokenAtIndex: number | null;

  @ApiPropertyOptional({ description: 'Human-readable reason when invalid.', nullable: true })
  reason?: string | null;
}

/**
 * Paginated audit listing. `verification` reflects the WHOLE tenant chain (not
 * just the returned page) — the integrity badge is chain-global. `items` are
 * newest-first for display; the chain is verified oldest→newest internally.
 */
export class HarnessAuditListResponse {
  @ApiProperty({ type: [HarnessAuditEventResponse] })
  items: HarnessAuditEventResponse[];

  @ApiProperty({ description: 'Total events matching the filter (across all pages).', example: 128 })
  total: number;

  @ApiProperty({ type: HarnessAuditVerificationResponse, description: 'Integrity verdict over the full tenant chain.' })
  verification: HarnessAuditVerificationResponse;
}

/**
 * Clinician edit-burden telemetry for one consultation.
 *
 * Derived, read-only scalars over the WORM audit + delivered/signed note versions
 * the gate already persists — the "how much did the human have to fix this"
 * proxy. PHI hygiene: only derived numbers/timestamps are exposed here; the note
 * text is consumed to compute the edit distance and NEVER returned. Any signal
 * whose input is absent is `null` — never a fabricated value.
 */
export class EditBurdenResponse {
  @ApiProperty({ description: 'Consultation the telemetry belongs to.' })
  consultationId: string;

  @ApiPropertyOptional({
    description:
      'Word-level edit distance between the delivered (RAW_SUMMARY) and signed (MODIFIED_SUMMARY) note. Null when a version is unavailable.',
    nullable: true,
  })
  editDistance: number | null;

  @ApiPropertyOptional({
    description: 'Edit distance normalised by delivered word count. Null when unavailable.',
    nullable: true,
  })
  editDistanceRatio: number | null;

  @ApiPropertyOptional({
    description: 'Fraction of gate decisions that were NOT a clean pass (FLAG/REGEN/escalated). Null when there were no gate decisions.',
    nullable: true,
  })
  deferralRate: number | null;

  @ApiProperty({ description: 'Total gate decisions observed for the consultation.' })
  gateDecisionTotal: number;

  @ApiProperty({ description: 'Number of gate decisions that were deferrals (non-clean).' })
  deferralCount: number;

  @ApiPropertyOptional({
    description: 'Seconds between note delivery and clinician sign-off. Null when a timestamp is missing.',
    nullable: true,
  })
  timeToSignSeconds: number | null;

  @ApiPropertyOptional({ description: 'Delivery timestamp (ISO-8601), or null.', nullable: true })
  deliveredAt: string | null;

  @ApiPropertyOptional({ description: 'Sign-off timestamp (ISO-8601), or null.', nullable: true })
  signedAt: string | null;
}
