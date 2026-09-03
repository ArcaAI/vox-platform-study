import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';

/**
 * One immutable promotion record, read from the TARGET tenant.
 *
 * moved the promotable from a `DepartmentAgentVersion` to a
 * `WorkflowDefinition` version. The FIELD NAMES here follow what they now
 * carry; the physical `AgentPromotion` columns behind them keep their original
 * names because the table is WORM (see `AgentPromotionService`'s header for the
 * mapping).
 */
export class AgentPromotionResponse {
  @ApiProperty({ description: 'Promotion id' })
  id!: string;

  @ApiProperty({ description: 'Tenant the agent was promoted FROM' })
  fromTenantId!: string;

  @ApiProperty({ description: 'Tenant the agent was promoted INTO (owns this record)' })
  toTenantId!: string;

  @ApiProperty({ description: 'The exact immutable WorkflowDefinition version row (in the source tenant) that was promoted' })
  sourceDefinitionVersionId!: string;

  @ApiProperty({ description: 'The source workflow definition’s slug — its identity across versions' })
  sourceDefinitionSlug!: string;

  @ApiProperty({ description: 'The workflow definition slug this promotion created in the target tenant' })
  targetDefinitionSlug!: string;

  @ApiPropertyOptional({ description: 'The WorkflowDefinition version row written in the target', nullable: true })
  targetDefinitionVersionId?: string | null;

  @ApiProperty({ description: 'The promoted graph, verbatim — with prompt bindings rewritten into the target and eval gates stripped' })
  configSnapshot!: Record<string, unknown>;

  @ApiProperty({ description: 'sha256 over the canonical JSON of the promoted graph' })
  checksum!: string;

  @ApiPropertyOptional({
    description: 'The eval run executed AT THE TARGET against the target’s own corpus. Null when no target golden set was named.',
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
      'True when the target definition’s CURRENT graph no longer matches what was promoted — ' +
      'i.e. it has been edited since. Computed at read time; absent when the target row could not be resolved.',
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
