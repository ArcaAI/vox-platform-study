import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HarnessPolicySource } from '../../harness-policy/dto';

/**
 * One consultation awaiting clinician review (TASK-330 Phase 6 gate queue).
 * The wait clock (`pendingSince`) is sourced from the audit trail — the latest
 * GENERATE event for the consultation — falling back to the consultation's
 * `updatedAt`. SLA/escalation deadlines come from the effective policy timers.
 */
export class GateQueueItemResponse {
  @ApiProperty({ description: 'Consultation awaiting review.' })
  consultationId: string;

  @ApiProperty({ description: 'Consultation status (always PENDING_REVIEW for queue items).', example: 'PENDING_REVIEW' })
  status: string;

  @ApiProperty({ description: 'When the consultation entered review (ISO-8601; from the latest GENERATE audit event or updatedAt).' })
  pendingSince: string;

  @ApiProperty({ description: 'Seconds the item has been waiting (now − pendingSince).', example: 3600 })
  ageSeconds: number;

  @ApiProperty({ description: 'Number of GENERATE (draft) events recorded for the consultation.', example: 1 })
  generateCount: number;

  @ApiProperty({ description: 'Bounded-regen count (generateCount − 1, floored at 0).', example: 0 })
  regenCount: number;

  @ApiProperty({ description: 'SLA deadline (ISO-8601; pendingSince + policy gateSlaSeconds).' })
  slaDueAt: string;

  @ApiProperty({ description: 'Escalation deadline (ISO-8601; pendingSince + policy gateEscalationSeconds).' })
  escalationDueAt: string;

  @ApiProperty({ description: 'True when now is past the SLA deadline.', example: false })
  slaBreached: boolean;

  @ApiProperty({ description: 'True when now is past the escalation deadline.', example: false })
  escalated: boolean;
}

/** The gate queue for a tenant + the policy timers used to compute deadlines. */
export class GateQueueResponse {
  @ApiProperty({ type: [GateQueueItemResponse] })
  items: GateQueueItemResponse[];

  @ApiProperty({ description: 'Total consultations awaiting review.', example: 4 })
  total: number;

  @ApiProperty({ description: 'How many items are past SLA.', example: 1 })
  slaBreachedCount: number;

  @ApiProperty({ description: 'How many items are past escalation.', example: 0 })
  escalatedCount: number;

  @ApiProperty({ description: 'Effective SLA seconds used for the computation.', example: 86400 })
  gateSlaSeconds: number;

  @ApiProperty({ description: 'Effective escalation seconds used for the computation.', example: 43200 })
  gateEscalationSeconds: number;

  @ApiProperty({ description: 'Where the SLA/escalation timers were resolved from.', enum: ['tenant', 'system-default', 'code-default'] })
  policySource: HarnessPolicySource;
}
