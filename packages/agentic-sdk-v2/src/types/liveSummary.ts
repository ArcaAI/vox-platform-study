/**
 * @arcaai/vox - Live running-SOAP stream types.
 *
 * Mirrors the gateway `LiveSummaryEventDto` (full-state snapshot published on
 * `consultation:live-summary:{id}` while recording). All stat/code fields are
 * optional + nullable — a field the engine omitted stays absent; never
 * fabricated.
 */

/** Per-flush generation stats (subset of the gateway `LiveSummaryStatsDto`). */
export interface LiveSummaryStats {
  /** the task key behind an interpreter-produced summary (selection is the assigned agent since TASK-876). */
  task_key?: string | null;
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
  /** Character offsets into `runningSummary` — the NOTE address the highlight overlay paints. */
  start?: number;
  end?: number;
  /**
   * The TRANSCRIPT address. NER runs over the transcript and the server then re-locates each
   * entity inside the rendered note, overwriting `start`/`end`; these survive that pass so a
   * client can jump to where the mention was actually spoken.
   *
   * One anchor, three fields: all present or all absent. Absent means the mention could not be
   * tied to a single timed utterance — never guessed. `transcriptSegmentId` is
   * `utt-<utteranceIndex>`; the offsets index THAT segment's own text.
   */
  transcriptSegmentId?: string;
  transcriptStart?: number;
  transcriptEnd?: number;
}

/** Structured vitals deterministically extracted by the NLP service; fields absent when unmatched. */
export interface LiveSummaryVitals {
  systolic?: number;
  diastolic?: number;
  heartRate?: number;
  spo2?: number;
  temperatureC?: number;
  weightKg?: number;
}

/** Full-state live running-SOAP snapshot. */
export interface LiveSummarySnapshot {
  consultationId: string;
  runningSummary: string;
  sections: LiveSummarySection[];
  entities: LiveSummaryEntity[];
  /**
   * provenance for an INTERPRETER-produced interim summary. Absent on an ordinary
   * live flush. `source: 'interpreter'` is what distinguishes the two; `ordinal`/`total`
   * position the snapshot within its sequence, and `metadata.stats.task_key` names the
   * resolved task.
   */
  source?: 'interpreter' | string;
  nodeType?: string;
  ordinal?: number;
  total?: number;
  /** Per-flush metadata envelope (`metadata.stats` = generation stats). */
  metadata?: { stats?: LiveSummaryStats | null } | null;
  /** Structured vitals (accumulated across flushes); absent until one is seen. */
  vitals?: LiveSummaryVitals;
  /** True when the most recent TEXT generation call failed; `runningSummary`/`sections` reflect the last successfully generated content (or are empty on a first-flush failure) — never fabricated. */
  textFailed?: boolean;
  updatedAt: string;
  /** Terminal event — recording stopped; the stream closes after this. */
  closed?: boolean;
}
