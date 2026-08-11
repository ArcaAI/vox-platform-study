import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';

/**
 * TASK-663 — one immutable promotion record, read from the TARGET tenant.
 */
export class AgentPromotionResponse {
  @ApiProperty({ description: 'Promotion id' })
  id!: string;

  @ApiProperty({ description: 'Tenant the agent was promoted FROM' })
  fromTenantId!: string;

  @ApiProperty({ description: 'Tenant the agent was promoted INTO (owns this record)' })
  toTenantId!: string;

  @ApiProperty({ description: 'The exact immutable DepartmentAgentVersion (in the source tenant) that was promoted' })
  agentVersionId!: string;

  @ApiProperty({ description: 'The source agent' })
  sourceAgentId!: string;

  @ApiProperty({ description: 'The agent row in the target tenant this promotion created or advanced' })
  targetAgentId!: string;

  @ApiPropertyOptional({ description: 'The immutable configuration version written in the target', nullable: true })
  targetAgentVersionId?: string | null;

  @ApiProperty({ description: 'The promoted loop-configuration snapshot, verbatim' })
  configSnapshot!: Record<string, unknown>;

  @ApiProperty({ description: 'sha256 over the canonical JSON of the promoted snapshot' })
  checksum!: string;

  @ApiPropertyOptional({
    description: 'The eval run executed AT THE TARGET against the target’s own corpus. Null when the target agent has no golden set.',
    nullable: true,
  })
  evalRunId?: string | null;

  @ApiPropertyOptional({
    description: 'A source-tenant eval run that travelled as an attestation only — never a result the target inherits.',
    nullable: true,
  })
  sourceEvalRunId?: string | null;

  @ApiProperty({
    description: 'Non-blocking operator alerts issued at promotion time (e.g. live consultations on the previous version).',
    type: [String],
  })
  warnings!: string[];

  @ApiPropertyOptional({ description: 'The acting user', nullable: true })
  promotedBy?: string | null;

  @ApiPropertyOptional({
    description:
      'True when the target agent’s CURRENT loop configuration no longer matches what was promoted — ' +
      'i.e. it has been edited since. Computed at read time; absent when the target agent could not be resolved.',
  })
  drifted?: boolean;

  @ApiProperty({ description: 'Promotion timestamp (ISO)' })
  createdAt!: string;

  @ApiProperty({ description: 'Row version', example: 1 })
  version!: number;
}

export class PaginatedAgentPromotionResponse extends PaginatedResponse<AgentPromotionResponse> {
  @ApiProperty({ type: [AgentPromotionResponse] })
  override readonly data!: readonly AgentPromotionResponse[];
}
