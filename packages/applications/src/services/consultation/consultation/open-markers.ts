/**
 * TASK-951 D-3/D-4 — the two facts a client STATES at open that HOPE has no column for.
 *
 * ## Why markers rather than columns
 *
 * `Consultation` carries no `visitType` and no external-reference column, and adding either is
 * a migration plus a back-fill for a value that (today) nothing indexes, sorts or joins on. The
 * repo already has a settled answer for exactly this shape — a durable, client-visible fact that
 * needs no query plan — and it is a namespaced key inside `Consultation.metadata`:
 * `governingEngine`, `workflowSelection` and the summary language all live there. OD-2 keeps
 * that answer and names the column as the upgrade path for the day one of these needs an index.
 *
 * ## What each one claims
 *
 * | Key | Claim | Written when |
 * |---|---|---|
 * | `visitType` | "the caller SAID this is a new visit / a revisit" | the effective context schema declares a `visitType` binding and the payload carried a value |
 * | `externalRef` | "the caller's own id for this encounter" | the effective context schema declares an `externalRef` binding and the payload carried a value |
 *
 * `visitType` is deliberately NOT a copy of the parent-link derivation. `selectVisitType` already
 * ranks a RECORDED value above `parentConsultationId`, so writing one here is what lets a caller
 * state `revisit` for a same-day review that has no parent row in HOPE, or `new-visit` for a
 * follow-up it has linked for its own reasons. Absent, every reader behaves exactly as it did
 * before this ticket: the parent link decides.
 *
 * `externalRef` is a LABEL, never a key. It is not part of `findByUniqueKey`'s
 * `(tenantId, patientId, appointmentDate, doctorId)` idempotency tuple (D-4/OD-3) — folding it in
 * would silently change get-or-create semantics for every existing caller, turning a re-open into
 * a second consultation the moment an integrator regenerated its event id.
 *
 * ## Forgery, and why nothing is stripped
 *
 * `Consultation.metadata` is client-writable at open (`OpenConsultationRequest.metadata`), so a
 * caller can post either key directly instead of declaring it in the schema. That is the same
 * situation `workflow-selection.ts` documents, and it has the same answer: neither key is a
 * privilege. A visit type selects which of the department's two prompt columns is read — an
 * outcome the same caller can already choose by sending (or omitting) `parentConsultationId` —
 * and an external reference is the caller's own identifier for its own encounter. So caller
 * metadata is MERGED, never stripped.
 *
 * The schema-declared value still WINS, because it is applied after: it was validated against the
 * tenant's pinned schema and alias-matched through the visit-type catalogue, and a hand-posted
 * `metadata.visitType` was neither.
 */

/** The namespaced key the stated visit type lives under inside `Consultation.metadata`. */
export const CONSULTATION_VISIT_TYPE_MARKER = 'visitType';

/** The namespaced key the caller's own encounter id lives under inside `Consultation.metadata`. */
export const CONSULTATION_EXTERNAL_REF_MARKER = 'externalRef';

/**
 * The platform's two visit-type keys, as the marker writer accepts them.
 *
 * The VOCABULARY itself lives in `../visit-type/visit-type.catalogue.ts` and is not restated
 * here — a caller narrows to this type by matching through `VisitTypeService.match`, which is
 * what honours the aliases (`referral` -> `new-visit`, `follow-up` -> `revisit`, …). Typing the
 * writer rather than re-listing the vocabulary is what keeps the two from drifting.
 */
export type ConsultationVisitTypeKey = 'new-visit' | 'revisit';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge the stated visit type into existing metadata, preserving every other key.
 *
 * Deliberately the same shape as `withWorkflowSelectionMarker` and `withSummaryLanguage`: client
 * metadata from `OpenConsultationRequest` must survive untouched, and the markers are independent
 * of one another, so each one merges rather than replaces.
 */
export function withVisitTypeMarker(metadata: unknown, key: ConsultationVisitTypeKey): Record<string, unknown> {
  return {
    ...(isPlainObject(metadata) ? metadata : {}),
    [CONSULTATION_VISIT_TYPE_MARKER]: key,
  };
}

/** Merge the caller's external encounter reference into existing metadata. See above. */
export function withExternalRefMarker(metadata: unknown, ref: string): Record<string, unknown> {
  return {
    ...(isPlainObject(metadata) ? metadata : {}),
    [CONSULTATION_EXTERNAL_REF_MARKER]: ref,
  };
}

/**
 * The visit type recorded on a consultation, or `null` when there is none.
 *
 * Returns the RAW stored string rather than a catalogue entry, for two reasons. It is what
 * `VisitTypeSelectionInput.recorded` takes, so every call site can hand it straight on; and
 * `selectVisitType` already treats an unmatchable value as "no opinion" and falls back to the
 * parent link, which is the pre-existing behaviour of every native path. Validating here as well
 * would put a second, divergent notion of the vocabulary in a second file.
 *
 * A non-string (or absent) value reads as ABSENT — the same fail-safe direction
 * `readWorkflowSelectionMarker` takes: fall back to the derivation, never to no answer at all.
 */
export function readRecordedVisitType(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null;
  const value = metadata[CONSULTATION_VISIT_TYPE_MARKER];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The caller's external encounter reference, or `null`. Same tolerance rules as above. */
export function readExternalRef(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null;
  const value = metadata[CONSULTATION_EXTERNAL_REF_MARKER];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
