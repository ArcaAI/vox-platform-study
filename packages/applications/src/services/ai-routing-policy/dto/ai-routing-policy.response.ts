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

  // ─────────── TASK-844 — the provider-configuration binding ───────────
  //
  // TASK-844 re-grained this table to ONE ROW PER PROVIDER CONFIGURATION and
  // moved the ordered chain off `candidatesJson` onto the rows themselves, but
  // the READ shape was never widened to match. Every field below already
  // existed on `AiRoutingPolicyEntity` and in `ProviderConfigurationRow`; they
  // were simply unreachable over HTTP, so no client could render the elected
  // default, the provider a configuration binds to, or the model it selects —
  // which is the whole substance of a configuration. Added by TASK-845, whose
  // Providers and Tasks tabs are the first read client.

  @ApiPropertyOptional({
    description: 'Canonical task taxonomy this `taskKey` belongs to (TASK-843). NULL means a row an un-migrated writer left unclassified.',
    nullable: true,
  })
  taskKind!: string | null;

  @ApiPropertyOptional({ description: 'Human label for this configuration. Not a key, and never part of resolution.', nullable: true })
  displayName!: string | null;

  @ApiPropertyOptional({ description: 'FK → AiProviderConnection.id — WHERE this configuration sends work and how it authenticates.', nullable: true })
  providerConnectionId!: string | null;

  @ApiPropertyOptional({ description: 'FK → AiModel.id — the catalogue model this configuration selects.', nullable: true })
  modelId!: string | null;

  @ApiPropertyOptional({
    description: 'Provider-side model id on the wire (an Azure deployment name, a GGUF id) when it differs from the catalogue slug.',
    nullable: true,
  })
  modelRef!: string | null;

  @ApiProperty({
    description:
      'The ELECTED default for this (tenantId, taskKey). At most one row per selection may carry it — a PostgreSQL partial unique index enforces that, ' +
      'so it is a fact about the database, not a convention. Elect with POST :id/default; it is deliberately not writable through create or update.',
  })
  isDefault!: boolean;

  @ApiProperty({ description: 'Candidate on/off without deleting the row. A disabled configuration is skipped by resolution and cannot be elected.' })
  enabled!: boolean;

  @ApiPropertyOptional({ description: 'Opaque residency-class label; compared for EQUALITY only by the §3A.4 fallback gates.', nullable: true })
  residency!: string | null;

  @ApiPropertyOptional({
    description: 'Whether a BAA covers this vendor AND this model. NULL is read as `false` by the gates — an unanswered question is not a yes.',
    nullable: true,
  })
  baaCovered!: boolean | null;

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
