import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Summary of the resolved `AiModel` registry row backing a task default. */
export class AiTaskModelSummary {
  @ApiProperty({ description: 'Registry row id' })
  id!: string;

  @ApiProperty({ description: 'Registry model slug' })
  slug!: string;

  @ApiProperty({ description: 'Human-readable model name' })
  name!: string;

  @ApiPropertyOptional({ description: 'Canonical runtime provider (ollama | lm-studio | azure | bedrock | built-in | sarvam)', nullable: true })
  provider!: string | null;

  @ApiPropertyOptional({ description: 'Model architecture family (gemma4, granite, ...)', nullable: true })
  architecture!: string | null;

  @ApiProperty({ description: 'Model task type' })
  taskType!: string;

  @ApiProperty({ description: 'Model format' })
  format!: string;

  @ApiProperty({ description: 'Provider-native identifier sent to the runtime' })
  sourceUri!: string;

  @ApiPropertyOptional({ description: 'Optional staged weights directory (operator override)', nullable: true })
  localPath!: string | null;

  /**
   * The row's `_metadata` blob (`AiModel._metadata`) — non-secret registry
   * extras that describe WHAT THIS CHECKPOINT IS and therefore travel with it:
   * `labelTaxonomy` (guardrail plane), `clinicalTaxonomy` (the nlp NER plane's
   * ontology vocabulary, vitals bands, ConText/NegEx triggers and NER contract),
   * `entailment` (the MiniCheck calibration gate's ground truth), `languages`,
   * `capabilities`, `policy`.
   *
   * It is surfaced here because the gateway is the ONLY tenant resolver: a
   * Python executor never reads the registry itself, so anything a caller must
   * forward has to arrive through this DTO. Nothing secret belongs in
   * `_metadata` — credentials live in `AiProviderConnection.encryptedApiKey`.
   */
  @ApiPropertyOptional({ description: 'Registry row `_metadata` (non-secret model descriptors)', nullable: true, type: Object })
  metadata!: Record<string, unknown> | null;
}

/**
 * @deprecated TASK-862 — removed in R3 (use `IAiRoutingPolicyService.resolveDefault`).
 *
 * The RESOLVED default model for an AI task: tenant row over the
 * SYSTEM platform row; `source` names the winning tier (null = neither row
 * exists and the consuming service falls back to its env bootstrap default).
 */
export class EffectiveAiTaskDefaultResponse {
  @ApiProperty({ description: 'Tenant the default was resolved for' })
  tenantId!: string;

  @ApiProperty({ description: 'AI task key', example: 'nlp.ner' })
  taskKey!: string;

  @ApiPropertyOptional({ description: 'Effective registry model slug (null when unconfigured)', nullable: true })
  modelSlug!: string | null;

  @ApiPropertyOptional({ description: "Winning cascade tier: 'tenant' | 'system' | null", nullable: true, enum: ['tenant', 'system'] })
  source!: 'tenant' | 'system' | null;

  @ApiPropertyOptional({ description: 'Task-specific extras from the winning row (JsonB)', nullable: true, type: Object })
  configJson?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Resolved registry model summary (ENABLED, [tenant, SYSTEM] preferring tenant); null when the slug resolves to nothing',
    nullable: true,
    type: AiTaskModelSummary,
  })
  model!: AiTaskModelSummary | null;
}
