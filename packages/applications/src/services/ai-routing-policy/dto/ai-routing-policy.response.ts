import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JsonValue } from '@arcaai/domains';

/** One persisted `AiRoutingPolicy` revision (TASK-818 §3A.3). */
export class AiRoutingPolicyResponse {
  @ApiProperty({ description: 'Policy id (uuid7)' })
  id!: string;

  @ApiProperty({ description: 'Owning tenant. The reserved SYSTEM tenant owns the platform default every tenant inherits.' })
  tenantId!: string;

  @ApiProperty({ description: 'AI task key this policy routes', example: 'text.finalize' })
  taskKey!: string;

  @ApiProperty({
    description:
      'AUTHORED revision, part of the natural key and the rollback target. Distinct from `version`, which is the OCC counter the database owns.',
    example: 1,
  })
  policyVersion!: number;

  @ApiProperty({ description: 'DRAFT | ACTIVE | ARCHIVED' })
  status!: string;

  @ApiProperty({ description: 'PRIORITY | WEIGHTED | LEAST_BUSY | LOWEST_LATENCY | LOWEST_COST' })
  strategy!: string;

  @ApiProperty({ description: 'STRICT | STRICT_UNLESS_OPTED_IN | POLICY_MAY_OVERRIDE. STRICT is the platform default (§3A.4).' })
  explicitProviderMode!: string;

  @ApiProperty({ description: 'Tie-break when two rows match equally specifically' })
  priority!: number;

  @ApiProperty({ description: 'Operator stop button. When true this policy serves nothing.' })
  killSwitch!: boolean;

  @ApiPropertyOptional({ description: 'Narrowing predicate: { models, metadata, minContextTokens, maxContextTokens }', nullable: true, type: Object })
  match!: JsonValue | null;

  @ApiProperty({ description: 'Ordered candidate chain: [{ rank, weight, connectionRef, model, residency, baaCovered, maxTtftMs }]', type: Object })
  candidates!: JsonValue;

  @ApiPropertyOptional({
    description: 'Fallback contract: { maxDepth, triggers, requireSameResidencyClass, requireBaaCovered, crossFundingAllowed }',
    nullable: true,
    type: Object,
  })
  fallback!: JsonValue | null;

  @ApiPropertyOptional({ description: 'Circuit/health thresholds (§3A.5)', nullable: true, type: Object })
  health!: JsonValue | null;

  @ApiPropertyOptional({ description: 'Cache-affinity / sticky-routing hints', nullable: true, type: Object })
  affinity!: JsonValue | null;

  @ApiPropertyOptional({ description: 'Concurrent-stream ceiling, or null for no ceiling here', nullable: true })
  maxConcurrentStreams!: number | null;

  @ApiPropertyOptional({ description: 'Requests-per-minute ceiling', nullable: true })
  requestsPerMinute!: number | null;

  @ApiPropertyOptional({ description: 'Tokens-per-minute ceiling', nullable: true })
  tokensPerMinute!: number | null;

  @ApiPropertyOptional({ description: 'The policyVersion this revision replaced (§3A.8 lineage)', nullable: true })
  supersedesVersion!: number | null;

  @ApiPropertyOptional({ description: 'When this revision was promoted to ACTIVE (ISO)', nullable: true })
  activatedAt!: string | null;

  @ApiPropertyOptional({ description: 'Resource status' })
  resourceStatus?: string;

  @ApiProperty({ description: 'OCC version — the If-Match/ETag token' })
  version!: number;

  @ApiPropertyOptional({ description: 'Created timestamp (ISO)' })
  createdAt?: string;

  @ApiPropertyOptional({ description: 'Updated timestamp (ISO)' })
  updatedAt?: string;

  @ApiPropertyOptional({ description: 'Actor who created this revision', nullable: true })
  createdBy?: string | null;

  @ApiPropertyOptional({ description: 'Actor who last changed this revision', nullable: true })
  updatedBy?: string | null;
}
