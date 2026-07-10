import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A single medical entity detected by the NLP service for the running summary.
 *
 * Mirrors the `/api/v1/classify/tokens` NLP response shape, re-keyed for the
 * frontend highlight overlay (`text` → `text`, `entity_type` → `type`, `position.{start,end}` → `start`/`end`).
 * NER is run over `runningSummary`
 * so `start`/`end` are character offsets into that flat text (the same text the
 * panel renders), letting the UI map each entity into the section it belongs to.
 */
export class LiveSummaryEntityDto {
  @ApiProperty({ description: 'The recognized text span (NLP `text`)' })
  text: string;

  @ApiProperty({ description: 'Entity class (e.g., MEDICATION, CONDITION, PROCEDURE, ANATOMY)' })
  type: string;

  @ApiPropertyOptional({ description: 'Model confidence (0.0 - 1.0)' })
  confidence?: number;

  @ApiPropertyOptional({ description: 'Character offset start within `runningSummary`' })
  start?: number;

  @ApiPropertyOptional({ description: 'Character offset end within `runningSummary`' })
  end?: number;
}

/**
 * A logical section of the running summary. When the SMR output parses as a
 * structured SOAP note the service emits the four canonical sections in order
 * (`Subjective`, `Objective`, `Assessment`, `Plan`) — some may have empty
 * `content` until the visit populates them. If the output is unstructured it
 * falls back to a single `Running Summary` section.
 */
export class LiveSummarySectionDto {
  @ApiProperty({ description: 'Section title: "Subjective" | "Objective" | "Assessment" | "Plan", or "Running Summary" (fallback)' })
  title: string;

  @ApiProperty({ description: 'Section body text (a contiguous substring of `runningSummary`); may be empty if not yet populated' })
  content: string;
}

/**
 * Offsets (into `runningSummary`) of a flagged — ungrounded — span (TASK-479 · SOTA D2).
 * Same offset contract as {@link LiveSummaryEntityDto} so the panel maps spans into
 * sections the way it already maps entity highlights.
 */
export class LiveSummaryFlaggedSpanDto {
  @ApiProperty({ description: 'Character offset start within `runningSummary`' })
  start: number;

  @ApiProperty({ description: 'Character offset end within `runningSummary`' })
  end: number;
}

/**
 * Groundedness verdict for one segment (sentence/line) of `runningSummary`
 * (TASK-479 · SOTA D2). `grounded` = the self-hosted NLI verified the segment against
 * the source transcript; `ungrounded` = the model contradicts/does not support it;
 * `unverified` = the gate could not check it (disabled, model unavailable, or an
 * error) — NEVER presented as verified.
 */
export class LiveSummaryGroundednessSegmentDto {
  @ApiProperty({ description: 'The segment text (a stripped substring of `runningSummary`)' })
  text: string;

  @ApiProperty({ description: 'Per-segment verdict', enum: ['grounded', 'ungrounded', 'unverified'] })
  verdict: 'grounded' | 'ungrounded' | 'unverified';

  @ApiPropertyOptional({ description: 'NLI entailment score (0.0 - 1.0) when the model ran' })
  score?: number;

  @ApiPropertyOptional({ description: 'Character offset start within `runningSummary`' })
  start?: number;

  @ApiPropertyOptional({ description: 'Character offset end within `runningSummary`' })
  end?: number;
}

/**
 * Output-side groundedness verdict for the running summary (TASK-479 · SOTA D2).
 *
 * Attached by the live-documentation flush AFTER the note is built and BEFORE it is
 * published, so an ungrounded segment can never reach the clinician unmarked. Worst-state
 * rollup: `ungrounded` > `unverified` > `grounded`. Fail-closed contract: an unavailable
 * or erroring gate yields `unverified` — no error path ever yields `grounded`. The live
 * mark is ephemeral UX; the durable harness remains the system of record.
 */
export class LiveSummaryGroundednessDto {
  @ApiProperty({
    description: 'Worst-state rollup across segments (`ungrounded` > `unverified` > `grounded`)',
    enum: ['grounded', 'ungrounded', 'unverified'],
  })
  verdict: 'grounded' | 'ungrounded' | 'unverified';

  @ApiPropertyOptional({ description: 'Per-segment verdicts', type: [LiveSummaryGroundednessSegmentDto] })
  segments?: LiveSummaryGroundednessSegmentDto[];

  @ApiPropertyOptional({ description: 'Offsets of the ungrounded spans within `runningSummary`', type: [LiveSummaryFlaggedSpanDto] })
  flaggedSpans?: LiveSummaryFlaggedSpanDto[];

  @ApiProperty({ description: 'ISO-8601 timestamp of when the verdict was produced' })
  checkedAt: string;
}

/**
 * Live-summary SSE event payload.
 *
 * Published to the Redis pub/sub channel `consultation:live-summary:{consultationId}`
 * by {@link LiveDocumentationService} and relayed verbatim to clients over
 * `GET /consultations/:id/live-summary/stream`. Transient — never persisted
 * per tick (the last snapshot may optionally be saved as a PRE_SUMMARY on stop).
 */
export class LiveSummaryEventDto {
  @ApiProperty({ description: 'Consultation this running summary belongs to' })
  consultationId: string;

  @ApiProperty({ description: 'Latest AI-generated running summary of the in-progress consultation' })
  runningSummary: string;

  @ApiProperty({ description: 'Summary broken into sections', type: [LiveSummarySectionDto] })
  sections: LiveSummarySectionDto[];

  @ApiProperty({ description: 'Medical entities detected in the running transcript', type: [LiveSummaryEntityDto] })
  entities: LiveSummaryEntityDto[];

  @ApiPropertyOptional({ description: 'STT segment id of the last final segment folded into this summary' })
  lastSegmentId?: string;

  @ApiPropertyOptional({
    description:
      'Output-side groundedness verdict (TASK-479). Optional and back-compatible: absent when the gate is disabled; `unverified` when the gate could not check (never silently `grounded`).',
    type: LiveSummaryGroundednessDto,
  })
  groundedness?: LiveSummaryGroundednessDto;

  @ApiProperty({ description: 'ISO-8601 timestamp of when this snapshot was produced' })
  updatedAt: string;

  @ApiPropertyOptional({ description: 'True on the terminal event published when recording stops; clients may close the stream' })
  closed?: boolean;
}
