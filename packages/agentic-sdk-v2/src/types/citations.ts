/**
 * @arcaai/vox - Provenance / Citations Types
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

/**
 * The four legacy SOAP section codes.
 *
 * These are still what `apps/harness` emits on the wire today
 * (`sensors/aggregator.py` → `DEFAULT_SOAP_SECTIONS = ("S","O","A","P")`), so
 * they keep a name, canonical ordering and canonical labels of their own — see
 * `SOAP_SECTIONS` / `SOAP_SECTION_LABELS` in `utils/citations`.
 */
export type LegacySoapSectionCode = 'S' | 'O' | 'A' | 'P';

/**
 * The section of a clinical document a claim belongs to (TASK-810).
 *
 * ## Why this is open rather than a four-value union
 *
 * This used to be `'S' | 'O' | 'A' | 'P'` — a CLOSED union, and the deepest
 * structural commitment to exactly four sections anywhere in the platform.
 * TASK-810 made document shapes tenant-authored: a `DocumentTemplate` declares
 * its own ordered sections, each with its own key, and SOAP is one row in that
 * catalog rather than the only expressible shape. A tenant publishing a
 * ten-section discharge summary could not previously even TYPE a claim against
 * it, so the review UI could not render one.
 *
 * The value is therefore a template SECTION KEY: either one of the four legacy
 * codes above, or a key from the tenant's published shape (`hospital_course`,
 * `follow_up`, …). The `(string & {})` half is what opens the union while
 * keeping the four legacy codes in editor autocomplete.
 *
 * Nothing here validates the key against a template — the SDK is a client, and
 * the pinned `DocumentTemplateVersion` on the server is the authority on which
 * sections exist.
 */
export type DocumentSectionKey = LegacySoapSectionCode | (string & {});

/**
 * @deprecated Renamed to {@link DocumentSectionKey} — a claim's section is a
 * document-template section key, and documents are no longer always SOAP.
 * Retained as an alias so existing imports keep compiling.
 */
export type SoapSection = DocumentSectionKey;

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
  /** Document-template section key the claim is filed under. */
  section: DocumentSectionKey;
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

/** A document section grouped with the claims filed under it. */
export interface DocumentSectionGroup {
  section: DocumentSectionKey;
  label: string;
  claims: CitationClaim[];
}

/**
 * @deprecated Renamed to {@link DocumentSectionGroup}. Retained as an alias so
 * existing imports keep compiling.
 */
export type SoapSectionGroup = DocumentSectionGroup;

/**
 * A section to group claims under: either a bare key, or a key paired with the
 * label to render. Pass the pair when you have the template's section TITLE —
 * it beats humanizing the key ("Reason for Admission" vs "Admission Reason").
 */
export type DocumentSectionSpec = DocumentSectionKey | { key: DocumentSectionKey; label: string };

/**
 * A contiguous run of transcript text, flagged for whether it falls inside a
 * highlighted evidence span. Produced by `buildTranscriptHighlights`.
 */
export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}
