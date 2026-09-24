import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';
import { LanguageCapabilityWarningResponse } from '../../stt/language-capability/language-capability-warning.response';

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

  /**
   * TASK-1004 §4.5 — advisory language warnings: a spoken-language mode the SPEECH_TO_TEXT agent's
   * PRIMARY engine serves only partially or not at all. Present only when there is something to
   * say; the write has already succeeded and nothing is re-routed.
   */
  @ApiPropertyOptional({
    type: () => [LanguageCapabilityWarningResponse],
    description:
      'TASK-1004 — advisory: spoken-language modes the SPEECH_TO_TEXT agent’s primary engine serves only partially (`degraded`) or not at all. Never blocks; nothing is re-routed. Absent when there is nothing to report.',
  })
  warnings?: LanguageCapabilityWarningResponse[];
}
