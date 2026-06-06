/**
 * @arcaai/vox - Provenance / Citations Types (TASK-330 Phase 1, Lane J)
 *
 * The clinical-documentation harness emits, alongside each generated SOAP
 * note, a `SummaryMeta.citationsMap` linking every drafted claim back to the
 * transcript span(s) it was grounded in. These types are the single source of
 * truth for that contract on the client; the linked-evidence review UI renders
 * straight off them.
 *
 * Contract (from the Phase-1 plan, "Provenance / citations contract"):
 *
 *   citationsMap = {
 *     claims: [
 *       { id, text, section: "S"|"O"|"A"|"P", confidence,
 *         status: "verified"|"unverified"|"flagged",
 *         evidence: [{ transcriptContextItemId, startOffset, endOffset, quote }],
 *         entityRefs: [namedEntityId], knowledgeChunkIds: [] }
 *     ]
 *   }
 */

// =============================================================================
// Claim provenance
// =============================================================================

/**
 * Per-claim verification status from the harness sensors.
 * - `verified`   — at least one sensor grounded the claim in the transcript.
 * - `unverified` — no provenance / sensors could not confirm (never dropped).
 * - `flagged`    — a sensor actively contradicted the claim (e.g. a dose
 *                  mismatch or a medication not present in the transcript).
 */
export type ClaimStatus = 'verified' | 'unverified' | 'flagged';

/** SOAP note section a claim belongs to. */
export type SoapSection = 'S' | 'O' | 'A' | 'P';

/**
 * A single piece of transcript evidence backing a claim. Offsets are character
 * positions into the referenced transcript context item's text.
 */
export interface ClaimEvidence {
  /** Context-item id of the transcript the offsets index into. */
  transcriptContextItemId: string;
  /** Inclusive character start offset of the evidence span. */
  startOffset: number;
  /** Exclusive character end offset of the evidence span. */
  endOffset: number;
  /** The quoted transcript text the span resolves to (for display/audit). */
  quote: string;
}

/**
 * A single drafted claim (one "note line") with its provenance.
 */
export interface CitationClaim {
  /** Stable claim id (unique within the citationsMap). */
  id: string;
  /** The claim text as it appears in the drafted note. */
  text: string;
  /** SOAP section the claim is filed under. */
  section: SoapSection;
  /** Sensor/model confidence in the claim, 0–1. */
  confidence: number;
  /** Verification status from the harness sensors. */
  status: ClaimStatus;
  /** Transcript spans grounding the claim (empty ⇒ no provenance). */
  evidence: ClaimEvidence[];
  /** Ids of `NamedEntity` rows referenced by the claim. */
  entityRefs: string[];
  /** Knowledge-chunk ids (institutional RAG) — always `[]` until Phase 3. */
  knowledgeChunkIds: string[];
}

/**
 * The provenance map persisted on `SummaryMeta.citationsMap`.
 */
export interface CitationsMap {
  claims: CitationClaim[];
}

/**
 * Computational sensor scores mirrored from `SummaryMeta` (each 0–1). Surfaced
 * read-only in the review header so a clinician sees why the note was gated.
 */
export interface SensorScores {
  entityFaithfulness: number;
  coverage: number;
  schemaValid: number;
  citationPresence: number;
  numericDose: number;
}

// =============================================================================
// Review aggregate (what the linked-evidence review screen renders)
// =============================================================================

/**
 * One transcript the claims can cite. A consultation may have several
 * transcript context items, so evidence references them by id.
 */
export interface TranscriptSource {
  /** Context-item id (matches `ClaimEvidence.transcriptContextItemId`). */
  contextItemId: string;
  /** Full transcript text the evidence offsets index into. */
  text: string;
  /** Optional human label (e.g. "Live transcription"). */
  label?: string;
}

/**
 * The full payload the clinician review screen needs: the draft note's claims
 * (with provenance), the transcript(s) to highlight, and the sensor context.
 *
 * `noteContextItemId` is the draft `ContextItem`/`SummaryMeta` id — i.e. the
 * approve target for `POST /consultations/:id/summary/:contextItemId/approve`.
 */
export interface ClinicalReviewData {
  consultationId: string;
  noteContextItemId: string;
  transcripts: TranscriptSource[];
  citationsMap: CitationsMap;
  sensorScores?: SensorScores;
  modelName?: string;
  /** Lifecycle status of the underlying note (e.g. PENDING_REVIEW / SIGNED). */
  status?: string;
}

// =============================================================================
// Derived view models (produced by the citations utilities)
// =============================================================================

/** A SOAP section grouped with the claims filed under it. */
export interface SoapSectionGroup {
  section: SoapSection;
  label: string;
  claims: CitationClaim[];
}

/**
 * A contiguous run of transcript text, flagged for whether it falls inside a
 * highlighted evidence span. Produced by `buildTranscriptHighlights`.
 */
export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}
