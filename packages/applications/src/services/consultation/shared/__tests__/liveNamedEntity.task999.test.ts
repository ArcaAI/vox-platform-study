/**
 * TASK-999 (D-2(c)) — the live lane's NER entities are PERSISTED, exactly once each.
 *
 * ============================================================================
 * THE TWO FAILURES THIS PINS
 * ============================================================================
 * 1. **They were never written at all.** The live lane extracted entities every flush, published
 *    them and recorded a `nlp.classify-tokens` trajectory step — which is pruned nightly — and
 *    persisted nothing. A consultation documented entirely through this lane ended with an
 *    entity count of zero and no way to recover one.
 *
 * 2. **Writing them naively duplicates every mention.** Each flush republishes the previous
 *    flushes' entities (`[...priorEntities, ...extracted]`), so a ten-minute consultation would
 *    persist the same aspirin a dozen times. The dedupe key is the entity's TRANSCRIPT ANCHOR
 *    plus its class and text — never its note offsets, which move whenever the running summary
 *    is rewritten, which is precisely what a naive key would trip on.
 *
 * The cross-path half of the rule is structural rather than a runtime check, and is asserted as
 * such below: the live lane writes only under the session's own PRE_SUMMARY snapshot row, while
 * `SummaryService.extractEntities` writes under the ContextItem its caller named. Two rows for
 * one clinical mention can only ever be two rows on two DIFFERENT documents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedEntityEntity } from '@arcaai/domains';

import { liveEntityIdentity, persistLiveNamedEntities, type LiveNerEntity } from '../liveNamedEntity';
import { namedEntityPropsFromNlp } from '../namedEntityFromNlp';

const TENANT = 'tenant-1';
const SNAPSHOT_ITEM = 'ctx-live-snapshot';

/** One anchored mention, as a flush publishes it. */
const aspirin = (overrides: Partial<LiveNerEntity> = {}): LiveNerEntity => ({
  text: 'aspirin',
  type: 'MEDICATION',
  confidence: 0.91,
  start: 42,
  end: 49,
  transcriptSegmentId: 'utt-3',
  transcriptStart: 10,
  transcriptEnd: 17,
  ...overrides,
});

function harness() {
  const rows: NamedEntityEntity[] = [];
  const createMany = vi.fn(async (batch: NamedEntityEntity[]) => {
    rows.push(...batch);
    return { count: batch.length };
  });
  return { rows, createMany, seen: new Set<string>() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('persistLiveNamedEntities — the live lane finally writes its entities (TASK-999)', () => {
  it('persists a flush’s entities under the session’s snapshot context item', async () => {
    // RED before the change: nothing in the live lane called the NamedEntity repository at all.
    const { rows, createMany, seen } = harness();

    const result = await persistLiveNamedEntities({
      entities: [aspirin(), aspirin({ text: 'cough', type: 'SYMPTOM', transcriptSegmentId: 'utt-1', transcriptStart: 3, transcriptEnd: 8 })],
      tenantId: TENANT,
      contextItemId: SNAPSHOT_ITEM,
      seen,
      createMany,
    });

    expect(result.persisted).toBe(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => row.contextItemId)).toEqual([SNAPSHOT_ITEM, SNAPSHOT_ITEM]);
    expect(rows.map((row) => row.className)).toEqual(['MEDICATION', 'SYMPTOM']);
    // The note offsets are what `startOffset`/`endOffset` mean — the location within the
    // document the row hangs off — and the transcript anchor rides the provenance columns.
    expect(rows[0].startOffset).toBe(42);
    expect(rows[0].transcriptStartOffset).toBe(10);
  });

  it('writes a carried-forward mention ONCE, even though its note offsets moved', async () => {
    // RED before the change (and the single most likely way to get this wrong): every flush
    // republishes prior entities, and `groundEntitiesToNote` re-locates them into the REWRITTEN
    // note, so `start`/`end` differ between flushes for a mention that has not changed. A key
    // built from them would write a fresh row on every tick.
    const { rows, createMany, seen } = harness();
    const params = { tenantId: TENANT, contextItemId: SNAPSHOT_ITEM, seen, createMany };

    await persistLiveNamedEntities({ ...params, entities: [aspirin({ start: 42, end: 49 })] });
    await persistLiveNamedEntities({ ...params, entities: [aspirin({ start: 118, end: 125 })] });
    await persistLiveNamedEntities({ ...params, entities: [aspirin({ start: 254, end: 261 })] });

    expect(rows).toHaveLength(1);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it('treats a repeat WITHIN one flush as one row too', async () => {
    // One flush can republish a prior entity beside a freshly extracted one that resolved to the
    // same anchor, so the batch needs the same guard the session-wide set gives across flushes.
    const { rows, seen, createMany } = harness();

    const result = await persistLiveNamedEntities({
      entities: [aspirin(), aspirin({ start: 99, end: 106 })],
      tenantId: TENANT,
      contextItemId: SNAPSHOT_ITEM,
      seen,
      createMany,
    });

    expect(result.persisted).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('keeps the SAME span in a DIFFERENT utterance as its own mention', async () => {
    // The anchor is what distinguishes two genuine mentions, so the key must not collapse them:
    // a clinician saying "aspirin" twice is two clinical facts, not one written twice.
    const { rows, seen, createMany } = harness();
    const params = { tenantId: TENANT, contextItemId: SNAPSHOT_ITEM, seen, createMany };

    await persistLiveNamedEntities({ ...params, entities: [aspirin({ transcriptSegmentId: 'utt-3' })] });
    await persistLiveNamedEntities({ ...params, entities: [aspirin({ transcriptSegmentId: 'utt-9' })] });

    expect(rows).toHaveLength(2);
  });

  it('records a key only once its row is actually written, so a failed insert is retried', async () => {
    // Recording keys optimistically would lose an entity permanently to one transient outage —
    // the next flush republishes it, and would then skip it.
    const seen = new Set<string>();
    const createMany = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ count: 1 });
    const params = { entities: [aspirin()], tenantId: TENANT, contextItemId: SNAPSHOT_ITEM, seen, createMany };

    await expect(persistLiveNamedEntities(params)).rejects.toThrow('db down');
    expect(seen.size).toBe(0);

    const result = await persistLiveNamedEntities(params);
    expect(result.persisted).toBe(1);
    expect(seen.size).toBe(1);
  });

  it('still writes an UNANCHORED entity exactly once', async () => {
    // A span crossing an utterance boundary, or an untimed ingest, has no anchor at all. It must
    // not be skipped, and it must not be written twice.
    const { rows, seen, createMany } = harness();
    const params = { tenantId: TENANT, contextItemId: SNAPSHOT_ITEM, seen, createMany };
    const unanchored: LiveNerEntity = { text: 'metformin', type: 'MEDICATION', start: 5, end: 14 };

    await persistLiveNamedEntities({ ...params, entities: [unanchored] });
    await persistLiveNamedEntities({ ...params, entities: [{ ...unanchored, start: 77, end: 86 }] });

    expect(rows).toHaveLength(1);
  });

  it('drops an entity with no text or no class rather than writing an empty row', async () => {
    const { rows, seen, createMany } = harness();

    const result = await persistLiveNamedEntities({
      entities: [{ text: '   ', type: 'MEDICATION' }, { text: 'aspirin', type: '  ' }],
      tenantId: TENANT,
      contextItemId: SNAPSHOT_ITEM,
      seen,
      createMany,
    });

    expect(result.persisted).toBe(0);
    expect(rows).toHaveLength(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('liveEntityIdentity — the dedupe key (TASK-999)', () => {
  it('ignores the note offsets and keeps the transcript anchor', () => {
    expect(liveEntityIdentity(aspirin({ start: 1, end: 8 }))).toBe(liveEntityIdentity(aspirin({ start: 900, end: 907 })));
    expect(liveEntityIdentity(aspirin({ transcriptStart: 10 }))).not.toBe(liveEntityIdentity(aspirin({ transcriptStart: 40 })));
  });

  it('folds case and whitespace in the span text only — two reports of one span are one mention', () => {
    expect(liveEntityIdentity(aspirin({ text: 'Aspirin' }))).toBe(liveEntityIdentity(aspirin({ text: '  aspirin ' })));
    expect(liveEntityIdentity(aspirin({ type: 'CONDITION' }))).not.toBe(liveEntityIdentity(aspirin({ type: 'MEDICATION' })));
  });
});

describe('the two extraction paths never share a parent document (TASK-999)', () => {
  it('binds live rows to the session snapshot and synchronous rows to the caller’s item', async () => {
    // This is the CROSS-PATH half of the dedupe rule, and it is structural: `contextItemId` is
    // the document an entity was found in, the live lane writes only under its own snapshot row,
    // and `extractEntities` writes under the TRANSCRIPT/CASE_NOTE item its caller named. A
    // per-consultation entity figure that must not double-count reads one document's rows.
    const { rows, seen, createMany } = harness();
    await persistLiveNamedEntities({ entities: [aspirin()], tenantId: TENANT, contextItemId: SNAPSHOT_ITEM, seen, createMany });

    const synchronous = namedEntityPropsFromNlp(
      { text: 'aspirin', entity_type: 'MEDICATION', position: { start: 10, end: 17 } },
      { tenantId: TENANT, contextItemId: 'ctx-transcript' },
    );

    expect(rows[0].contextItemId).toBe(SNAPSHOT_ITEM);
    expect(synchronous.contextItemId).toBe('ctx-transcript');
    expect(rows[0].contextItemId).not.toBe(synchronous.contextItemId);
  });
});
