import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One transcript segment cited as evidence for the summary (TASK-552 Lane C).
 * Resolved server-side from `citationsMap`'s cited segment ids (both the flat
 * `segmentCitedIds` array and `claims[].evidence[].segmentId`) against the
 * consultation's persisted `TranscriptSegment` rows. Carries offsets/timing
 * ONLY — never the segment text itself (no duplicated PHI on the wire): the
 * console already holds the full transcript text (via
 * `GET :id/context/transcriptions`) and slices `[charStart, charEnd)` locally
 * to render the evidence snippet and to scroll/highlight the source span.
 */
export class CitedSegmentResponse {
  @ApiProperty({ description: 'TranscriptSegment id' })
  id: string;

  @ApiProperty({ description: '0-based ordinal within the transcript' })
  idx: number;

  @ApiPropertyOptional({ description: 'Segment start time (ms from recording start)', nullable: true })
  t0Ms?: number | null;

  @ApiPropertyOptional({ description: 'Segment end time (ms from recording start)', nullable: true })
  t1Ms?: number | null;

  @ApiPropertyOptional({ description: 'Diarization / speaker label', nullable: true })
  speaker?: string | null;

  @ApiPropertyOptional({ description: 'Character offset charStart (inclusive) into the parent transcript content', nullable: true })
  charStart?: number | null;

  @ApiPropertyOptional({ description: 'Character offset charEnd (exclusive) into the parent transcript content', nullable: true })
  charEnd?: number | null;
}

/**
 * Read-only provenance for a generated summary.
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
    description: 'Full sensor-score detail object emitted by the harness (persisted in the SummaryMeta.guardrailDecisions column)',
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

  @ApiPropertyOptional({
    description:
      'Cited transcript segments (TASK-552 Lane C), resolved from citationsMap against the persisted TranscriptSegment rows. Empty (not missing) when the consultation has no single resolvable transcript, no segments are persisted, or nothing was cited — best-effort, never blocks the read.',
    type: [CitedSegmentResponse],
  })
  citedSegments: CitedSegmentResponse[];
}
