import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Which table answered a block.
 *
 * FROZEN by TASK-999 §3.1 C-1, with ONE addition: `'consultation'`. The frozen
 * union named seven CHILD tables and no value for the `Consultation` row
 * itself, but D-1 settled the session block on that row's own
 * `createdAt`/`updatedAt` — so emitting `'context-item'` there would name a
 * table this endpoint never reads for that block. The union is widened rather
 * than the source misreported; see `ConsultationTelemetryResponse.session`.
 */
export const TELEMETRY_SOURCES = [
  'summary-meta',
  'usage-ledger',
  'agent-trajectory',
  'named-entity',
  'audio-recording',
  'context-item',
  'transcription-job',
  // TASK-999 Lane B addition to the frozen C-1 union — see above.
  'consultation',
] as const;

export type TelemetrySource = (typeof TELEMETRY_SOURCES)[number];

/**
 * WHY a block is empty — the whole point of the discriminated shape.
 *
 * The pane must never render a fabricated zero, and "we do not capture this",
 * "we capture it and there was none" and "we captured it and retention removed
 * it" are three different answers a clinician-facing admin needs told apart.
 *
 * - `NOT_RECORDED` — the platform does not capture this value at all (or did
 *   not at the time these rows were written). A pre-TASK-999 case note has a
 *   NULL `contentWordCount`; no amount of activity will make it appear.
 * - `NO_ACTIVITY` — the value IS captured, and this consultation has none.
 * - `PRUNED` — it existed and retention removed it. Only reachable for
 *   `partialSummary`, whose only source (`AgentTrajectoryStep`) is hard-pruned
 *   nightly.
 */
export const TELEMETRY_UNAVAILABLE_REASONS = ['NOT_RECORDED', 'NO_ACTIVITY', 'PRUNED'] as const;

export type TelemetryUnavailable = (typeof TELEMETRY_UNAVAILABLE_REASONS)[number];

/**
 * One telemetry block: either it has data, or it says why it does not.
 *
 * Two rules the whole contract rests on, and they are NOT the same rule:
 *   1. An absent VALUE inside an available block is `null` — the block ran, the
 *      field was not measured.
 *   2. A block with nothing behind it is `available: false` with a reason —
 *      never `available: true` carrying zeros.
 *
 * Modelled as one class with optional members rather than a TS union because
 * Swagger cannot render a discriminated union of anonymous shapes; the
 * INVARIANT (`data` present iff `available`, `reason` present iff not) is
 * enforced by the two builders below, which are the only way blocks are made.
 */
export class TelemetryBlock<T> {
  @ApiProperty({ description: 'True when `data` is present. False when `reason` explains its absence.' })
  available!: boolean;

  @ApiProperty({
    enum: TELEMETRY_SOURCES,
    nullable: true,
    description: 'Which table answered. Null only on an unavailable block whose source could not be attributed.',
  })
  source!: TelemetrySource | null;

  @ApiPropertyOptional({ description: 'Present iff `available` is true.' })
  data?: T;

  @ApiPropertyOptional({
    enum: TELEMETRY_UNAVAILABLE_REASONS,
    description: 'Present iff `available` is false.',
  })
  reason?: TelemetryUnavailable;
}

/** A block that has data. */
export function availableBlock<T>(source: TelemetrySource, data: T): TelemetryBlock<T> {
  return { available: true, source, data };
}

/** A block that does not, and says why. */
export function unavailableBlock<T>(source: TelemetrySource | null, reason: TelemetryUnavailable): TelemetryBlock<T> {
  return { available: false, source, reason };
}

/** ONE model call. */
export class LlmStats {
  @ApiProperty({ type: Number, nullable: true })
  inputTokens!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  outputTokens!: number | null;

  @ApiProperty({ type: String, nullable: true })
  model!: string | null;

  @ApiProperty({ type: String, nullable: true })
  provider!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  durationMs!: number | null;
}

/** MANY model calls of one kind, rolled up. */
export class LlmAggregate {
  @ApiProperty({ description: 'How many calls were rolled up. Always > 0 on an available block.' })
  callCount!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Summed over the calls that reported tokens; null when none did.' })
  inputTokens!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  outputTokens!: number | null;

  @ApiProperty({
    type: [String],
    description: 'Every DISTINCT model seen across the calls, sorted. May be empty when no call named one.',
  })
  models!: string[];

  @ApiProperty({ type: String, nullable: true, description: 'The single provider, or null when the calls disagree or none named one.' })
  provider!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Mean over the calls that reported a duration; null when none did.' })
  avgDurationMs!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  totalDurationMs!: number | null;
}

/** `session` block payload. */
export class SessionTelemetry {
  @ApiProperty({ description: 'Consultation.createdAt (ISO-8601).' })
  startedAt!: string;

  @ApiProperty({
    description:
      'Consultation.updatedAt (ISO-8601). This is when the consultation ROW last changed — writing a case note touches ContextItem, not this row, so it is NOT a MAX over children (TASK-999 D-1(a)).',
  })
  lastActivityAt!: string;

  @ApiProperty({ description: 'lastActivityAt - startedAt, in milliseconds.' })
  durationMs!: number;
}

/** `caseNotes` block payload. */
export class CaseNoteTelemetry {
  @ApiProperty({ description: 'Every ENABLED CASE_NOTE context item of the consultation.' })
  count!: number;

  @ApiProperty({
    description:
      'The subset carrying a non-NULL write-time counter. Every pre-TASK-999 row is NULL, so this lets the pane say "12 notes, 9 measured" rather than imply the other three are empty.',
  })
  measuredCount!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Summed over the MEASURED notes only; null when measuredCount is 0.' })
  wordCount!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  charCount!: number | null;
}

/** `transcription` block payload. */
export class TranscriptionTelemetry {
  @ApiProperty({ description: 'Transcription jobs recorded for the consultation.' })
  jobCount!: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Recorded audio duration in milliseconds.' })
  durationMs!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Summed over jobs carrying a write-time counter; null when none do.' })
  wordCount!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  charCount!: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'From the job that actually served (`servedBy`), falling back to the ledger row.' })
  model!: string | null;

  @ApiProperty({ type: String, nullable: true })
  provider!: string | null;
}

/** `ner` block payload. */
export class NerTelemetry {
  @ApiProperty({ description: 'Persisted NamedEntity rows across every context item of the consultation.' })
  entityCount!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'entityCount grouped by NamedEntity.className.',
  })
  byLabel!: Record<string, number>;

  @ApiProperty({ description: 'Distinct `ner.extract` invocations in the usage ledger. 0 when the ledger recorded none.' })
  callCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Summed from the CPU/GPU-second rows of the `ner.extract` ledger events — the only place a per-CALL NER duration lives. NamedEntity.processingTimeMs is stamped identically on every entity of one call and double-counts on a SUM, so it is deliberately not read.',
  })
  totalDurationMs!: number | null;
}

/**
 * `GET /admin/consultations/:id/telemetry` — TASK-999 §3.1 C-1.
 *
 * Eight independent blocks over six tables. Every block is resolved on its own:
 * one source being empty never suppresses another, and a consultation with no
 * AI activity at all answers `available: false` eight times rather than
 * throwing.
 */
export class ConsultationTelemetryResponse {
  @ApiProperty()
  consultationId!: string;

  @ApiProperty({ description: 'When this payload was computed (ISO-8601). Nothing here is cached.' })
  generatedAt!: string;

  @ApiProperty({ type: TelemetryBlock, description: 'Session span. Source `consultation` — see TELEMETRY_SOURCES.' })
  session!: TelemetryBlock<SessionTelemetry>;

  @ApiProperty({ type: TelemetryBlock, description: 'Case-note count + write-time length counters. Source `context-item`.' })
  caseNotes!: TelemetryBlock<CaseNoteTelemetry>;

  @ApiProperty({ type: TelemetryBlock, description: 'Transcription duration/length/model. Source `transcription-job` or `audio-recording`.' })
  transcription!: TelemetryBlock<TranscriptionTelemetry>;

  @ApiProperty({ type: TelemetryBlock, description: 'The pre-summary pass. Source `summary-meta`.' })
  preSummary!: TelemetryBlock<LlmStats>;

  @ApiProperty({ type: TelemetryBlock, description: 'Live-document flush calls. Source `agent-trajectory` (nightly-pruned).' })
  partialSummary!: TelemetryBlock<LlmAggregate>;

  @ApiProperty({ type: TelemetryBlock, description: 'The final summary. Source `summary-meta`.' })
  finalSummary!: TelemetryBlock<LlmStats>;

  @ApiProperty({ type: TelemetryBlock, description: 'Entities + extraction calls. Source `named-entity`.' })
  ner!: TelemetryBlock<NerTelemetry>;

  @ApiProperty({ type: TelemetryBlock, description: 'Guardrail validation calls. Source `usage-ledger`.' })
  guardrail!: TelemetryBlock<LlmAggregate>;
}
