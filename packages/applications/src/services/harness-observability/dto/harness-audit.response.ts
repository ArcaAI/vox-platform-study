import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HarnessAuditAction, JsonValue } from '@arcaai/domains';

/**
 * One WORM audit row (TASK-330 Phase 6 — read projection of `HarnessAuditEvent`).
 * Append-only + hash-chained; `prevHash`/`hash` expose the tamper-evident chain
 * so the console can show the verification badge.
 */
export class HarnessAuditEventResponse {
  @ApiProperty({ description: 'Audit event id (time-sortable UUIDv7; ordering reflects append order).' })
  id: string;

  @ApiProperty({ description: 'Owning tenant id.' })
  tenantId: string;

  @ApiProperty({ description: 'Consultation the event belongs to.' })
  consultationId: string;

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
