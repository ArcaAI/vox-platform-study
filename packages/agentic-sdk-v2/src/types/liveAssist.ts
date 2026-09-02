/**
 * @arcaai/vox - Live clinician-assist stream types.
 *
 * Mirrors the gateway `LiveAssistEventDto` published on
 * `consultation:live-assist:{id}` and relayed by
 * `GET /consultations/:id/live-assist/stream`
 * (`packages/applications/src/services/consultation/harness/dto/realtime-delivery.dto.ts`).
 *
 * Two things about this feed decide how a consumer must treat it:
 *
 * 1. **It is a FULL-STATE snapshot carrying BOTH branches.** A publish replaces
 *    only the branch it carries and the gateway folds the other one back in
 *    (`HarnessLiveAssistService.fold`), so each event is the whole current
 *    truth. Never merge successive events client-side — an absent branch means
 *    "there are none", and re-merging would resurrect withdrawn PHI.
 * 2. **Nothing here has been applied.** `corrections.applied` is `false` under
 *    proposal-first: the clinician decides. `original` quotes the clinician's
 *    own text verbatim, which is why the whole plane is declared PHI-carrying.
 *
 * Optional fields are optional because the interpreter may omit them; a field
 * the engine did not send stays absent rather than being fabricated.
 */

/** One interpreter suggestion shown to the clinician. */
export interface LiveAssistSuggestion {
  /** Stable id, so the console can accept/dismiss one suggestion. */
  suggestionId: string;
  /** The suggestion text. */
  text: string;
  /** Free-form grouping key, e.g. `"history"`. */
  category?: string;
  /** Lifecycle state as the interpreter sees it, e.g. `"PROPOSED"`. */
  status?: string;
  /** Attribution, e.g. `"lm-studio:a-model"`. */
  proposedBy?: string;
}

/**
 * One PROPOSED correction over a character span of the note.
 *
 * `start`/`end` are offsets into the text named by
 * {@link LiveAssistCorrections.textSha256} — check that hash before applying a
 * proposal, or the offsets may land on drifted text.
 */
export interface LiveAssistProposal {
  /** Stable id, so an accept/reject decision is attributable to one proposal. */
  proposalId: string;
  /** Character offset where the replaced span starts. */
  start: number;
  /** Character offset where the replaced span ends. */
  end: number;
  /** The existing text, verbatim (PHI). */
  original: string;
  /** The proposed replacement. */
  proposed: string;
  /** What kind of correction, e.g. `"drugName"`. */
  category?: string;
  /** Model/detector confidence, 0.0 – 1.0. */
  confidence?: number;
  /** Why the correction is proposed, shown to the clinician. */
  rationale?: string;
  /** What flagged it, e.g. `"nlp.ner"`. */
  detectedBy?: string;
  /** What proposed the replacement, e.g. `"lm-studio:a-model"`. */
  proposedBy?: string;
  /** Lifecycle state as the interpreter sees it, e.g. `"PROPOSED"`. */
  status?: string;
}

/** The `corrections` branch — the proposals from the newest run. */
export interface LiveAssistCorrections {
  /** The proposals; the newest run wins. */
  proposals: LiveAssistProposal[];
  /**
   * Whether the machine already wrote these into the note. Proposal-first
   * means `false`: the clinician decides. Declared REQUIRED by the gateway
   * precisely so a publish can never be ambiguous about it.
   */
  applied: boolean;
  /** How many proposals were auto-applied (0 under proposal-first). */
  appliedCount?: number;
  /** How many the interpreter itself discarded before publishing. */
  rejectedProposals?: number;
  /** SHA-256 of the text the offsets were computed against. */
  textSha256?: string;
}

/** Full-state live clinician-assist snapshot (both branches). */
export interface LiveAssistEvent {
  consultationId: string;
  tenantId?: string;
  /** Absent means "no suggestions", not "unchanged". */
  suggestions?: LiveAssistSuggestion[];
  /** Absent means "no proposals", not "unchanged". */
  corrections?: LiveAssistCorrections;
  /** Which node last wrote the `suggestions` branch, for provenance. */
  suggestionsNodeType?: string;
  /** Which node last wrote the `corrections` branch, for provenance. */
  correctionsNodeType?: string;
  provider?: string;
  model?: string;
  updatedAt: string;
}
