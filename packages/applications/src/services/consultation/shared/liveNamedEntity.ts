import { NamedEntityFactory, type NamedEntityEntity } from '@arcaai/domains';

import { namedEntityPropsFromNlp, type NlpNamedEntity } from './namedEntityFromNlp';

/**
 * Persisting the LIVE lane's NER entities (TASK-999, D-2(c)).
 *
 * ============================================================================
 * THE GAP THIS CLOSES
 * ============================================================================
 * The live-documentation lane extracts entities from the raw transcript on every flush,
 * publishes them onto the clinician's feed, records a `nlp.classify-tokens` trajectory step —
 * and then throws them away. The SYNCHRONOUS clinical path (`SummaryService.extractEntities`)
 * persists its own. So a consultation documented entirely through the live lane has an entity
 * count of zero forever, and the nightly trajectory prune takes even the step with it.
 *
 * ============================================================================
 * THE DEDUPE RULE — stated once, here, because it is the whole risk
 * ============================================================================
 * Writing both paths' entities without a rule gives one consultation two overlapping entity
 * sets. The rule has two halves, and they answer two different questions.
 *
 * **1. Within the live lane: one row per DISTINCT MENTION, identified by its TRANSCRIPT
 * ANCHOR plus its class and text** — `className | transcriptSegmentId | transcriptStart |
 * transcriptEnd | text`.
 *
 * Every flush republishes the entities of previous flushes (`[...priorEntities, ...extracted]`),
 * so without a rule the same mention is written once per tick — a ten-minute consultation would
 * persist one aspirin a dozen times.
 *
 * The NOTE offsets (`start`/`end`) are deliberately NOT in the key. They address the running
 * summary, which is rewritten on every flush, so they move for a mention that has not changed;
 * keying on them would defeat the dedupe entirely. The transcript anchor is the opposite: it is
 * frozen by the flush that extracted the entity and is never re-anchored (`anchorEntitiesToTranscript`
 * is applied to a flush's OWN entities only), so it is stable for the mention's whole life.
 *
 * An entity with no anchor at all — an untimed ingest, or a span crossing an utterance boundary —
 * falls back to `className | | | | text`, so it is still written exactly once rather than
 * skipped or duplicated.
 *
 * The key set lives on the SESSION and dies with it. That is sufficient, not a compromise: a
 * resumed session restores its note from the durable snapshot but NOT its entities
 * (`session.lastPayload` is rebuilt with `entities: []`), so after a restart only genuinely new
 * mentions flow through here.
 *
 * **2. Across the two paths: they never share a parent row.** `NamedEntity.contextItemId` is the
 * DOCUMENT an entity was found in. The live lane writes only under the session's own
 * `LIVE_SOAP_SNAPSHOT` PRE_SUMMARY row (`session.snapshotId`), which it creates and upserts and
 * which no other extraction path targets; `SummaryService.extractEntities(contextItemId)` writes
 * under the item its CALLER named — a TRANSCRIPT or CASE_NOTE. Two rows for the same clinical
 * mention can therefore only ever be two rows on two DIFFERENT documents, which is exactly what
 * that column means. A per-consultation entity figure that must not double-count reads one
 * document's rows, never the union of every document's.
 *
 * ============================================================================
 * NO SECOND MAPPING
 * ============================================================================
 * The NLP → `NamedEntity` field contract has ONE owner, `namedEntityPropsFromNlp`, and it stays
 * that way: this module re-keys the live DTO onto the NLP wire shape and hands it to that
 * function rather than filling `CreateNamedEntityProps` itself. A second mapping is how the
 * synchronous and asynchronous paths drifted apart before.
 */

/**
 * The live lane's entity as the flush payload carries it (`LiveSummaryEntityDto`), structurally
 * typed so this module does not import the live-documentation feature from `shared/`.
 */
export interface LiveNerEntity {
  text: string;
  type: string;
  confidence?: number;
  icd10?: string;
  /** Offsets into the RENDERED NOTE — the document these rows hang off. Not part of the key. */
  start?: number;
  end?: number;
  /** The frozen transcript anchor. All three together, or none. Part of the key. */
  transcriptSegmentId?: string;
  transcriptStart?: number;
  transcriptEnd?: number;
}

/** What one persist pass did. Counts only — never an entity, never a span. */
export interface LiveEntityPersistResult {
  persisted: number;
  skipped: number;
}

/**
 * The stable identity of one live entity — see the dedupe rule above.
 *
 * `text` is lower-cased and whitespace-collapsed for the KEY only; the persisted row keeps the
 * span verbatim. Two reports of the same anchored span differing only in case or spacing are the
 * same mention.
 */
export function liveEntityIdentity(entity: LiveNerEntity): string {
  const text = entity.text.trim().replace(/\s+/g, ' ').toLowerCase();
  const anchor = [entity.transcriptSegmentId ?? '', entity.transcriptStart ?? '', entity.transcriptEnd ?? ''].join('|');
  // `text` is LAST, so the only fields a separator could be ambiguous in are the constrained
  // ones: a class name is SCREAMING_CASE and a segment id is `utt-<n>`. Neither contains a pipe.
  return [entity.type.trim(), anchor, text].join('|');
}

/**
 * Re-key one live DTO onto the NLP wire shape {@link namedEntityPropsFromNlp} owns.
 *
 * `start`/`end` become `position` (the offsets within the parent document, which is what
 * `NamedEntity.startOffset`/`endOffset` mean), and `icd10` becomes `icd_code` — the live lane's
 * only ontology code, resolved by the NLP linker and named differently on the two contracts.
 */
export function liveEntityToNlp(entity: LiveNerEntity): NlpNamedEntity {
  return {
    text: entity.text,
    entity_type: entity.type,
    confidence: entity.confidence ?? null,
    position: { start: entity.start ?? null, end: entity.end ?? null },
    icd_code: entity.icd10 ?? null,
  };
}

export interface PersistLiveNamedEntitiesParams {
  entities: readonly LiveNerEntity[];
  tenantId: string;
  /** The session's own PRE_SUMMARY snapshot row — the ONE document the live lane writes under. */
  contextItemId: string;
  /** The session's key set. Mutated: a key is added only once its row has actually been written. */
  seen: Set<string>;
  /** Batched insert — `NamedEntityRepository.createMany`. */
  createMany: (entities: NamedEntityEntity[]) => Promise<unknown>;
  /** Per-entity Vault-Transit encryption of the free-text span. Omitted in a fixture without secrets. */
  encrypt?: (entity: NamedEntityEntity) => Promise<void>;
}

/**
 * Persist the entities of one flush that have not been persisted yet.
 *
 * Keys are recorded only AFTER the insert succeeds, so a failed write is retried by the next
 * flush (which republishes the same entities) instead of being lost silently.
 */
export async function persistLiveNamedEntities(params: PersistLiveNamedEntitiesParams): Promise<LiveEntityPersistResult> {
  const { entities, tenantId, contextItemId, seen, createMany, encrypt } = params;

  const fresh: { key: string; entity: LiveNerEntity }[] = [];
  const batchKeys = new Set<string>();
  for (const entity of entities) {
    if (!entity?.text?.trim() || !entity?.type?.trim()) continue;
    const key = liveEntityIdentity(entity);
    // `batchKeys` guards the WITHIN-flush repeat too: one flush can republish a prior entity
    // alongside a freshly extracted one that resolved to the same anchor.
    if (seen.has(key) || batchKeys.has(key)) continue;
    batchKeys.add(key);
    fresh.push({ key, entity });
  }

  if (fresh.length === 0) return { persisted: 0, skipped: entities.length };

  const rows: NamedEntityEntity[] = [];
  for (const { entity } of fresh) {
    const row = NamedEntityFactory.CreateNamedEntity({
      ...namedEntityPropsFromNlp(liveEntityToNlp(entity), { tenantId, contextItemId }),
      // The transcript anchor, onto the provenance columns, when the flush resolved one.
      // `transcriptContextItemId` stays NULL: the live lane has no TRANSCRIPT `ContextItem` to
      // point at (those are written by the STT ingest path, keyed elsewhere), and a fabricated
      // FK is worse than an absent one.
      ...(entity.transcriptStart !== undefined && entity.transcriptEnd !== undefined
        ? { transcriptStartOffset: entity.transcriptStart, transcriptEndOffset: entity.transcriptEnd }
        : {}),
    });
    if (encrypt) await encrypt(row);
    rows.push(row);
  }

  await createMany(rows);
  for (const { key } of fresh) seen.add(key);

  return { persisted: rows.length, skipped: entities.length - rows.length };
}
