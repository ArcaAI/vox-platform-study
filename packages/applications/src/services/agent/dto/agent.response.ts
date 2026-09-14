import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentTask } from '@arcaai/domains';

export class AgentFallbackResponse {
  @ApiProperty() priority!: number;
  @ApiProperty() modelId!: string;
  @ApiPropertyOptional({ nullable: true }) modelSlug?: string | null;
  @ApiProperty() enabled!: boolean;
}

export class AgentFindingResponse {
  @ApiProperty({ enum: ['ERROR', 'WARNING'] }) severity!: 'ERROR' | 'WARNING';
  @ApiProperty() code!: string;
  @ApiProperty() path!: string;
  @ApiProperty() message!: string;
}

export class AgentValidationReportResponse {
  @ApiProperty({ description: 'ISO timestamp' }) checkedAt!: string;
  @ApiProperty() blocking!: boolean;
  @ApiProperty({ type: [AgentFindingResponse] }) findings!: AgentFindingResponse[];
}

/** One `Agent` row — which IS a version. Timestamps are ISO-8601 strings. */
export class AgentResponse {
  @ApiProperty() id!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: AgentTask }) task!: AgentTask;
  @ApiProperty() versionNumber!: number;
  @ApiPropertyOptional({ nullable: true }) parentVersionId!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'TASK-884 — the agent version this row was CLONED or SYNCED from (a different lineage, possibly another tenant).',
  })
  sourceAgentId!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The tenant that owned the clone source.' }) sourceTenantId!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The clone source’s lineage slug.' }) sourceSlug!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The clone source’s version number.' }) sourceVersionNumber!: number | null;
  @ApiProperty({ enum: ['DRAFT', 'VALIDATED', 'PUBLISHED', 'DEPRECATED'] }) status!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() modelId!: string;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'TASK-890 §3.4 — the tenant context schema this agent pins; its derived payload schema is frozen into `compiledConfig.contextSchema` at publish.',
  })
  contextSchemaId!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The pinned schema VERSION; null ⇒ follow the schema’s own pin.' })
  contextSchemaVersionNumber!: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'The backing model`s registry slug (joined for display).' }) modelSlug!: string | null;
  @ApiProperty({ type: [AgentFallbackResponse] }) fallbacks!: AgentFallbackResponse[];
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true }) instruction!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true }) parameters!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true }) inputSchema!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true }) outputSchema!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true, type: 'array', items: { type: 'object', additionalProperties: true } }) tools!: Array<
    Record<string, unknown>
  > | null;
  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true, description: 'Server-stamped at publish; null until then.' })
  compiledConfig!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true }) compiledConfigChecksum!: string | null;
  @ApiPropertyOptional({ nullable: true, type: AgentValidationReportResponse }) validationReport!: AgentValidationReportResponse | null;
  @ApiPropertyOptional({ nullable: true }) validatedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) deprecatedAt!: string | null;
  @ApiProperty() resourceStatus!: string;
  /**
   * TASK-974 D-1 — a PLATFORM HIDDEN agent: one the platform owns and serves to every tenant
   * through its own resolver, never through the business plane.
   *
   * DERIVED from the compiled-in `PLATFORM_HIDDEN_AGENTS` allow-list, not stored on the row, so
   * it cannot be set by an edit. It appears on the ADMIN projection only — `listPublished` /
   * `getPublishedBySlug` never return such an agent at all, so a business-plane reader has
   * nothing to read this on. A console uses it to LABEL the row ("Hidden · platform") and to
   * keep it out of tenant-facing pickers.
   */
  @ApiProperty({ description: 'Platform-owned agent: never cloned, listed, invoked or assignable on the business plane.' }) hidden!: boolean;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ description: 'ISO timestamp' }) createdAt!: string;
  @ApiProperty({ description: 'ISO timestamp' }) updatedAt!: string;
  @ApiPropertyOptional({ nullable: true }) createdBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) updatedBy!: string | null;
  /** `_version` — echo back via `If-Match: "<version>"` on the next write. */
  @ApiProperty() version!: number;
}
