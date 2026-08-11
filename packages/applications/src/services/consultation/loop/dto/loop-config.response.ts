import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One resolved subscription entry: a subscribed context kind and the ordered
 * action list the loop dispatches when that kind's context arrives.
 */
export class LoopSubscriptionDto {
  @ApiProperty({ description: 'The subscribed context kind key (from the department/tenant context schema).' })
  kindKey: string;

  @ApiProperty({ description: 'The ordered, deduplicated action keys to dispatch for this kind.', type: [String] })
  actions: string[];
}

/** Bounded execution envelope for the loop workflow. */
export class LoopConfigBudgetDto {
  @ApiProperty({ description: 'Maximum recursion/fan-out depth the loop may reach.' })
  maxDepth: number;

  @ApiProperty({ description: 'Maximum total actions the loop may dispatch in one run.' })
  maxActions: number;
}

/**
 * TASK-662 — the resolved, deterministic loop configuration for one
 * consultation. Returned by `GET /internal/harness/loop-config`; every
 * resolution failure degrades to `enabled: false` rather than throwing (see
 * `LoopConfigService.resolveForConsultation`).
 */
export class LoopConfigResponse {
  @ApiProperty({ description: 'Whether a loop is actually configured for this consultation.' })
  enabled: boolean;

  @ApiPropertyOptional({ description: 'The consultation id, or null when the consultation could not be resolved.', nullable: true })
  consultationId: string | null;

  @ApiPropertyOptional({ description: "The consultation's department id.", nullable: true })
  departmentId: string | null;

  @ApiPropertyOptional({ description: "The resolved department default agent's id.", nullable: true })
  agentId: string | null;

  @ApiPropertyOptional({ description: "The agent's latest immutable loop-config version snapshot id.", nullable: true })
  agentConfigVersionId: string | null;

  @ApiPropertyOptional({ description: 'The resolved servable ConsultationContextSchemaVersion id.', nullable: true })
  contextSchemaVersionId: string | null;

  @ApiProperty({ description: 'Resolved per-kind action subscriptions.', type: [LoopSubscriptionDto] })
  subscriptions: LoopSubscriptionDto[];

  @ApiProperty({ description: 'Bounded execution envelope.', type: LoopConfigBudgetDto })
  budget: LoopConfigBudgetDto;

  @ApiProperty({ description: 'Actions to dispatch when the loop starts.', type: [String] })
  startActions: string[];

  @ApiProperty({ description: 'Actions to dispatch when the loop ends.', type: [String] })
  endingActions: string[];
}
