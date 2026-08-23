/**
 * TASK-796's brokered wire contract for the two realtime clinician planes.
 *
 * Source of truth: `apps/harness/src/harness/tests/unit/services/test_live_delivery_client.py`
 * on `feat/task-796-realtime-summary-text` — the executable copy of both publish bodies. These
 * types were transcribed from that file, not from prose.
 *
 * TRANSPORT STATUS: the gateway routes that carry this (`POST .../live-summary`,
 * `POST .../live-assist`, and the `GET /consultations/:id/live-assist/stream` SSE the console
 * consumes) DO NOT EXIST YET — they are assigned to TASK-795. The surfaces below are built and
 * unit-tested against these shapes; they will not receive live data until 795 lands.
 *
 * Interim SUMMARIES need nothing here: they arrive on the EXISTING live-summary plane
 * (`LiveSummarySnapshot` in `./types.ts`, already consumed via `useArcaLiveSummary`), which
 * gains `source`/`nodeType`/`ordinal`/`total` and `metadata.stats.task_key`.
 */

/** `_CORRECTION_CATEGORIES` in the harness node — the only three accepted values. */
export type CorrectionCategory = 'spelling' | 'medicalTerm' | 'drugName';

/**
 * Decision state. Per 796 rule 1, this advances ONLY on an explicit clinician action —
 * nothing auto-applies.
 */
export type LiveAssistStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED';

/**
 * One correction proposal.
 *
 * `proposalId` is a content-derived SHA-256 that is stable across Temporal activity retries.
 * Per 796 rule 3 it — never an array index — is the list key, so a dismissed proposal stays
 * dismissed when the same envelope is re-delivered after a retry.
 */
export interface CorrectionProposal {
  proposalId: string;
  /** Byte offsets into the exact revision pinned by `CorrectionsEnvelope.textSha256`. */
  start: number;
  end: number;
  original: string;
  proposed: string;
  category: CorrectionCategory;
  confidence: number;
  rationale: string;
  /** 796 rule 4, half one: what FOUND the span (e.g. `nlp.ner`). */
  detectedBy: string;
  /** 796 rule 4, half two: `provider:model` that PROPOSED the replacement. */
  proposedBy: string;
  status: LiveAssistStatus;
}

/**
 * `applied` is always `false` and `appliedCount` always 0 — the harness returns the source text
 * byte-identical. The contract test asserts `applied` survives pruning precisely because it is
 * "a safety assertion, not an empty value".
 */
export interface CorrectionsEnvelope {
  proposals: CorrectionProposal[];
  applied: false;
  appliedCount: number;
  rejectedProposals?: number;
  /** SHA-256 of the exact text the offsets index. 796 rule 2's gate. */
  textSha256: string;
}

/** One suggestion. `suggestionId` is content-derived and stable across retries (796 rule 3). */
export interface ClinicalSuggestion {
  suggestionId: string;
  text: string;
  category?: string;
  status: LiveAssistStatus;
  /** `provider:model`. */
  proposedBy?: string;
}

/**
 * The `live-assist` SSE payload. `kind` discriminates: a suggestions publish carries no
 * `corrections` key and a corrections publish carries no `suggestions` key.
 */
export interface LiveAssistEnvelope {
  kind: 'suggestions' | 'corrections';
  nodeType: string;
  provider?: string;
  model?: string;
  suggestions?: ClinicalSuggestion[];
  corrections?: CorrectionsEnvelope;
}

/** Ticket scope for the live-assist SSE, following the `consultation_*` namespace convention. */
export const liveAssistScopeFor = (consultationId: string) => `consultation_live_assist:${consultationId}`;

/** Gateway-relative SSE path (TASK-795 will mount it). */
export const liveAssistStreamPath = (consultationId: string) => `consultations/${encodeURIComponent(consultationId)}/live-assist/stream`;
