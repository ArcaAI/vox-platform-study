import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-330 follow-up — read-only provenance for a generated summary.
 *
 * Surfaces the harness-written `SummaryMeta` provenance (per-claim `citationsMap`
 * + the sensor score columns + the full sensor-score detail + `modelName`) over
 * HTTP so a clinician/UI can audit how a draft was scored. Previously these were
 * only verifiable via the DB.
 */
export class SummaryProvenanceResponse {
  @ApiProperty({ description: 'Summary (ContextItem) id this provenance belongs to' })
  contextItemId: string;

  @ApiPropertyOptional({ description: 'Generating model name', nullable: true })
  modelName?: string | null;

  @ApiPropertyOptional({ description: 'Entity-faithfulness sensor score (0..1)', nullable: true })
  entityFaithfulnessScore?: number | null;

  @ApiPropertyOptional({ description: 'Coverage / omission sensor score (0..1)', nullable: true })
  coverageScore?: number | null;

  @ApiPropertyOptional({ description: 'RAG-triad sensor score (0..1)', nullable: true })
  ragTriadScore?: number | null;

  @ApiPropertyOptional({
    description:
      'Full sensor-score detail object emitted by the harness (persisted in the SummaryMeta.guardrailDecisions column)',
    type: Object,
    nullable: true,
  })
  sensorScores?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Per-claim citation / provenance map ({ claims: [{ id, text, section, status, evidence }] })',
    type: Object,
    nullable: true,
  })
  citationsMap?: unknown;

  @ApiPropertyOptional({ description: 'When the draft was generated (ISO-8601)', nullable: true })
  generatedAt?: string | null;
}
