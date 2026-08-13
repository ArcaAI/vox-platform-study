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
 * One agent in the consultation's roster, as the reasoning lane
 * pins it at workflow start.
 *
 * `subscribedKinds` is the agent's READ scope and `writeScope` its WRITE scope.
 * Both are resolved HERE, gateway-side, and frozen into the pinned config, so a
 * mid-consultation edit to the agent cannot widen either one for a loop that is
 * already running.
 */
export class LoopAgentDto {
  @ApiProperty({ description: 'The DepartmentAgent id.' })
  agentId: string;

  @ApiProperty({ description: 'PRIMARY (owns the note and the gate) or SPECIALIST.', enum: ['PRIMARY', 'SPECIALIST'] })
  role: string;

  @ApiPropertyOptional({ description: "The agent's slug.", nullable: true })
  slug: string | null;

  @ApiPropertyOptional({ description: "The agent's constrained goal.", nullable: true })
  goal: string | null;

  @ApiProperty({ description: 'Context kinds this agent may READ (its whole read scope).', type: [String] })
  subscribedKinds: string[];

  @ApiProperty({ description: 'Output kinds this agent may WRITE. `note`/`gate` are refused for a specialist regardless.', type: [String] })
  writeScope: string[];

  @ApiPropertyOptional({ description: "The agent's latest immutable config-version snapshot id.", nullable: true })
  agentConfigVersionId: string | null;
}

/**
 * The resolved, deterministic loop configuration for one
 * consultation. Returned by `GET /internal/harness/loop-config`; every
 * resolution failure degrades to `enabled: false` rather than throwing (see
 * `LoopConfigService.resolveForConsultation`).
 *
 * Added `reasoningEnabled` + `agents` ADDITIVELY, with defaults that
 * reproduce behaviour exactly. That is what lets the harness's frozen
 * loop replay fixture keep passing: a config recorded before this ticket
 * deserialises with the reasoning lane OFF and never enters its patch era.
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

  @ApiProperty({ description: 'Whether the deliberative lane (planner + specialists + adjudication) runs for this consultation.' })
  reasoningEnabled: boolean;

  @ApiProperty({ description: 'The pinned agent roster: exactly one PRIMARY plus its specialists.', type: [LoopAgentDto] })
  agents: LoopAgentDto[];

  /**
   * The loop's IDLE lifecycle bound, in seconds, or null for no
   * bound. Added ADDITIVELY with a null default for the same reason
   * `reasoningEnabled`/`agents` were: a harness that predates this ticket
   * ignores it, and a config recorded before it deserialises with no bound, so
   * the frozen loop replay fixtures never enter the `task-685-idle-timeout`
   * patch era.
   *
   * Resolved HERE, gateway-side, and frozen into the pinned config, because the
   * workflow body may not re-read configuration mid-run without breaking replay
   * determinism (C1).
   */
  @ApiPropertyOptional({
    description: 'Seconds of total silence (no context item, no ending, no cancel) after which the loop abandons the run. Null = unbounded.',
    nullable: true,
  })
  idleTimeoutSeconds: number | null;
}
