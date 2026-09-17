import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentTask } from '@arcaai/domains';

/** The business-plane projection of a published agent (`GET /api/v1/agents`). */
export class AgentSummaryResponse {
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: AgentTask }) task!: AgentTask;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ description: 'Whether the tenant`s assignment cascade (tenant tier, no department) resolves this slug for its task.' })
  isTenantDefault!: boolean;
  @ApiProperty({ type: 'object', additionalProperties: true }) inputSchema!: Record<string, unknown>;
  @ApiProperty({ type: 'object', additionalProperties: true }) outputSchema!: Record<string, unknown>;
  /**
   * TASK-983 R9 — the placeholder PATHS this agent's instruction reads that carry no
   * `default("…")` and that the agent does not bind itself. Sorted and de-duplicated.
   *
   * Send each one under the request key its root names: `trigger.*` / `context.*` → `context`,
   * `input.*` → the invocation body, a bare name → `variables`. Omitting one is a 400
   * `PROMPT_VARIABLES_MISSING`, which names ALL of the missing paths at once.
   *
   * A composite instruction publishes the WORST case: a path only a conditional fragment reads
   * is listed, and a call that does not take that branch is not asked for it.
   */
  @ApiProperty({
    type: [String],
    description: 'Placeholder paths an invocation must supply (no `default(...)`, not bound by the agent). Sorted, de-duplicated.',
  })
  requiredVariables!: string[];
}

export class AgentSummaryListResponse {
  @ApiProperty({ type: [AgentSummaryResponse] }) data!: AgentSummaryResponse[];
}
