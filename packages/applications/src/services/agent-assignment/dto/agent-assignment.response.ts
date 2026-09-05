import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';

export class AgentAssignmentResponse {
  @ApiProperty() id!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty({ enum: PipelinePolicyScope }) scope!: PipelinePolicyScope;
  @ApiPropertyOptional({ nullable: true }) scopeId?: string | null;
  @ApiProperty({ enum: AgentTask }) task!: AgentTask;
  @ApiProperty() agentSlug!: string;
  @ApiProperty({
    type: [String],
    description: 'TASK-884 — the canonical `key:value` selector qualifying this assignment; empty = the tier’s unqualified row.',
  })
  selectorTags!: string[];
  @ApiProperty({ description: 'ISO timestamp' }) createdAt!: string;
  @ApiProperty({ description: 'ISO timestamp' }) updatedAt!: string;
  /** `_version` — echo back via `If-Match: "<version>"` on the next write. */
  @ApiProperty() version!: number;
}
