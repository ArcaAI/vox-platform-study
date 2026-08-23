/**
 * ⚠ LOCALLY-DECLARED SHAPES — NOT YET A BROKERED WIRE CONTRACT ⚠
 *
 * TASK-797 W2 (R3/R4). Three harness capabilities produce output that nothing displays:
 * interim summaries, intelligent suggestions, and spelling / medical-term / drug-name
 * correction proposals. TASK-796 is defining the wire contracts for all three.
 *
 * VERIFIED STATE OF THE WORLD as of this commit (checked against source, not comments):
 *
 *  - `apps/harness/src/harness/temporal/interpreter/nodes/consultation_realtime.py`
 *    implements all three nodes, and `packages/workflow-contract/src/node-registry.ts`
 *    registers `consultation.realtimeSummary`, `consultation.suggestions` and
 *    `consultation.proposeCorrections` as `implemented: true`.
 *  - Their output is an in-memory `NodeActivityResult.output` dict. There is NO Prisma
 *    model, NO gateway route, NO DTO class and NO console client function for suggestions
 *    or corrections anywhere in the repo.
 *  - So the console cannot fetch either one today. The components built on these types are
 *    complete and tested; they have no transport.
 *
 * The shapes below MIRROR the harness node output exactly, field for field, because that is
 * the only concrete producer that exists. They are declared HERE, in one file, so that when
 * TASK-796 brokers the real contract exactly one module changes.
 *
 * Do not treat this file as authoritative. See the ticket README's `requestedContracts[]`.
 */

/** `_CORRECTION_CATEGORIES` in the harness node — the only three accepted values. */
export type CorrectionCategory = 'spelling' | 'medicalTerm' | 'drugName';

/**
 * One correction PROPOSAL. Mirrors the dict built in `_verified_proposals`.
 *
 * `status` is `'PROPOSED'` for everything the harness emits; the other members exist so the
 * console can record a local decision without inventing a second representation.
 */
export interface CorrectionProposal {
  /** Character offsets into the proposal set's source text. */
  start: number;
  end: number;
  /** The source text at `[start, end)`. The harness guarantees this; the console re-checks it. */
  original: string;
  proposed: string;
  category: CorrectionCategory;
  /** 0.0-1.0, clamped by the harness. */
  confidence: number;
  rationale: string;
  /** The detector that found the span, e.g. `nlp.ner`. */
  detectedBy: string;
  /** `provider:model` of the model that proposed the replacement. */
  proposedBy: string;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED';
}

/**
 * `interpreter_consultation_propose_corrections`'s output.
 *
 * `text` is byte-identical to the input and `applied` is ALWAYS false — a system that
 * silently rewrites a drug name or a dose is a patient-safety defect. The console must never
 * render a proposal as though it had already been applied.
 */
export interface CorrectionProposalSet {
  text: string;
  proposals: CorrectionProposal[];
  applied: false;
  appliedCount: 0;
  /** Count the harness itself dropped because they failed its own verification. */
  rejectedProposals?: number;
  provider?: string;
  model?: string;
}

/** One entry from `interpreter_consultation_suggestions`' `{"suggestions": [...]}`. */
export interface ClinicalSuggestion {
  text: string;
  category?: string;
}

export interface ClinicalSuggestionSet {
  suggestions: ClinicalSuggestion[];
  count?: number;
  provider?: string;
  model?: string;
}
