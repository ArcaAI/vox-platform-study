/**
 * Who wrote a TRANSCRIPT `ContextItem` — the discriminator the STT finalize
 * idempotency guard needs.
 *
 * There are two writers of `type: TRANSCRIPT` rows and they mean different
 * things:
 *
 *   1. The **STT aggregate** — one row per consultation, written by
 *      `SttInternalService` when the stream finalizes (or a batch job
 *      completes). This is the row whose creation emits
 *      `TranscriptionCreated`, which is the SOLE trigger for
 *      `ConsultationEventHandler` → harness note generation.
 *   2. **Per-segment client writes** — the SDK posts one row per final
 *      utterance through `POST /consultations/:id/context`
 *      (`useArcaAudio`/`useArcaContext.addTranscription`). Many rows per
 *      consultation, no clinical-note semantics.
 *
 * The finalize guard used to test `findTranscripts(consultationId).length > 0`
 * — i.e. type alone — so the FIRST per-segment row would satisfy it, the
 * aggregate would be skipped, and no note would ever be generated. Silently.
 * (Historically masked by a DTO mismatch that rejected every per-segment POST
 * with a 400; see )
 *
 * The predicate below is evaluated SERVER-SIDE and does not trust the client:
 *
 *   - the aggregate carries a positive `metaData.subType` marker we stamp
 *     ourselves at both STT write sites;
 *   - rows written before that marker existed carry no `subType` at all, and
 *     are still recognised as aggregates — the internal STT path has no CLS
 *     user, so `createdBy` is null/system, whereas a client write through
 *     `ContextService.addContext` always stamps the real requesting user id.
 *
 * A client that omits the segment marker therefore still cannot suppress the
 * aggregate: its `createdBy` gives it away.
 */

/** Platform system user; the `createdBy` an internal, user-less write leaves behind. */
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

/** `metaData.subType` stamped on the one aggregate transcript per consultation. */
export const STT_AGGREGATE_SUBTYPE = 'STT_AGGREGATE';

/** `metaData.subType` the SDK stamps on each per-utterance transcript row. */
export const TRANSCRIPT_SEGMENT_SUBTYPE = 'TRANSCRIPT_SEGMENT';

/** The minimum shape this module needs; keeps it free of a domains import. */
export interface TranscriptProvenanceShape {
  metaData?: Record<string, unknown> | null;
  createdBy?: string | null;
}

/**
 * True when `item` is the STT-written aggregate transcript — the row the
 * finalize idempotency guard must key on.
 */
export function isSttAggregateTranscript(item: TranscriptProvenanceShape): boolean {
  const subType = item.metaData?.subType;

  if (subType === STT_AGGREGATE_SUBTYPE) {
    return true;
  }
  if (typeof subType === 'string') {
    // Any other marker (notably TRANSCRIPT_SEGMENT) is explicitly not the aggregate.
    return false;
  }

  // Unmarked row: an aggregate written before the marker existed iff nothing
  // interactive authored it.
  return !item.createdBy || item.createdBy === SYSTEM_USER_ID;
}
