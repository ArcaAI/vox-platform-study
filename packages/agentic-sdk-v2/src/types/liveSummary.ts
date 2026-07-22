/**
 * @arcaai/vox - Live running-SOAP stream types (TASK-543).
 *
 * Mirrors the gateway `LiveSummaryEventDto` (full-state snapshot published on
 * `consultation:live-summary:{id}` while recording). All stat/code fields are
 * optional + nullable — a field the engine omitted stays absent; never
 * fabricated.
 */

/** Per-flush generation stats (subset of the gateway `LiveSummaryStatsDto`). */
export interface LiveSummaryStats {
  total_ms?: number | null;
  ttft_ms?: number | null;
  tokens_per_second?: number | null;
  prompt_tokens?: number | null;
  predicted_tokens?: number | null;
  provider?: string | null;
  model?: string | null;
}

/** A logical section of the running summary (SOAP heading, or "Running Summary" fallback). */
export interface LiveSummarySection {
  title: string;
  content: string;
}

/** A medical entity detected in the running transcript. */
export interface LiveSummaryEntity {
  text: string;
  type: string;
  confidence?: number;
  /** ICD-10-CM code from the NLP OntologyLinker (curated vocabulary); absent otherwise. */
  icd10?: string;
  start?: number;
  end?: number;
}

/** Full-state live running-SOAP snapshot. */
export interface LiveSummarySnapshot {
  consultationId: string;
  runningSummary: string;
  sections: LiveSummarySection[];
  entities: LiveSummaryEntity[];
  /** Per-flush metadata envelope (`metadata.stats` = generation stats). */
  metadata?: { stats?: LiveSummaryStats | null } | null;
  updatedAt: string;
  /** Terminal event — recording stopped; the stream closes after this. */
  closed?: boolean;
}
