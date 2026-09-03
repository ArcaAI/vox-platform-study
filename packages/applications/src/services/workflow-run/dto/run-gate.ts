import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The clinician decision a caller may send when releasing a run's HITL gate.
 *
 * Deliberately NARROW. Notably absent: `clinicianId`. The signer is resolved server-side from
 * the acting user's CLS context, because a body field naming the signer is exactly the forgery
 * shape `03-compliance-posture.md` §3 forbids — a caller must never be able to record someone
 * else as having signed. `tenantId` is likewise absent: it comes from the tenant scope the
 * request was already authorized under.
 */
export class ApproveRunGateInput {
  @ApiPropertyOptional({
    description: "The decision recorded on the WORM GATE_DECISION audit event. Defaults to 'SIGNED'.",
    enum: ['SIGNED', 'REJECTED'],
    default: 'SIGNED',
  })
  @IsOptional()
  @IsString()
  @IsIn(['SIGNED', 'REJECTED'])
  decision?: string;

  @ApiPropertyOptional({
    description: 'The summary version the clinician actually signed, when they edited before signing.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  contextItemVersionId?: string;

  @ApiPropertyOptional({ description: 'Attestation hash carried onto the audit record.' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  attestationHash?: string;
}

/**
 * Live gate state for a run, read from the gate child workflow.
 *
 * `waiting` is the ONLY field a client should key an Approve affordance off. `exists: false` is
 * the normal answer for every run without a gate (all summarization/stt runs, and any
 * consultation run that has not reached its gate yet) — a plain 200, never an error.
 */
export class RunGateStateResponse {
  @ApiProperty({ description: 'The domain run id.' })
  runId: string;

  @ApiProperty({ description: 'True when this run has a gate child workflow at all.' })
  exists: boolean;

  @ApiProperty({
    description: 'True only while the gate is genuinely parked on a human decision. A decided or abandoned gate is false.',
  })
  waiting: boolean;

  @ApiPropertyOptional({ description: 'GATE | RECORD | DONE | ABANDONED.' })
  phase?: string;

  @ApiPropertyOptional({ description: 'How many SLA-breach escalations have fired so far.' })
  escalations?: number;

  @ApiPropertyOptional({ description: 'True once a real approval signal has been received.' })
  approved?: boolean;

  constructor(data: Partial<RunGateStateResponse> = {}) {
    this.runId = data.runId ?? '';
    this.exists = data.exists ?? false;
    this.waiting = data.waiting ?? false;
    this.phase = data.phase;
    this.escalations = data.escalations;
    this.approved = data.approved;
  }
}
