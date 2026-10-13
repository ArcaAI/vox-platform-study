/**
 * Section rows are scoped to the ENCOUNTER that wrote them.
 *
 * A consultation's `DocumentSection` rows are keyed `(consultation, document, section)`, so the
 * rows an earlier encounter wrote outlive the append of the next one. Before this, a later
 * encounter's flush either hit the earlier encounter's LOCKED row and was refused (its section never
 * existed), or appended onto the earlier encounter's draft; and every read served the earlier
 * encounter's text as the consultation's document.
 *
 * What this suite pins:
 *  1. every flush write stamps the encounter it belongs to on the row (`_metadata.encounterSeq`);
 *  2. a flush from a LATER encounter supersedes a row an earlier encounter wrote — whatever its
 *     state — and starts the section fresh (no carried body, no carried confirmation or lock);
 *  3. a late flush from an EARLIER encounter never touches a row a later encounter owns;
 *  4. within one encounter nothing changes: a LOCKED row still refuses, an append still accumulates;
 *  5. a write that names no encounter behaves exactly as before;
 *  6. resuming a note reads only the rows of the session's own encounter.
 */
import { describe, it, expect, vi } from 'vitest';
import { DocumentSectionFactory, DocumentSectionState, type DocumentSectionEntity } from '@arcaai/domains';
import { DocumentSectionStore, sectionEncounterSeq, type SectionWriteInput } from '../section-store';

const CID = 'consultation-enc';
const TENANT = 'tenant-enc';

function repositoryDouble() {
  const rows = new Map<string, DocumentSectionEntity>();
  return {
    rows,
    findSection: vi.fn(async (_t: string, _c: string, _d: string, sectionKey: string) => rows.get(sectionKey) ?? null),
    findByDocument: vi.fn(async () => [...rows.values()]),
    create: vi.fn(async (entity: DocumentSectionEntity) => {
      rows.set(entity.sectionKey, entity);
      return entity;
    }),
    updateWithVersion: vi.fn(async (_id: string, entity: DocumentSectionEntity, expectedVersion: number) => {
      (entity as unknown as { _version: number })._version = expectedVersion + 1;
      rows.set(entity.sectionKey, entity);
      return entity;
    }),
    encryptContentIntoEntity: vi.fn(async () => undefined),
  };
}

const write = (over: Partial<SectionWriteInput> = {}): SectionWriteInput => ({
  consultationId: CID,
  tenantId: TENANT,
  documentKey: 'soap_note',
  sectionKey: 'plan',
  title: 'Plan',
  idx: 1,
  content: 'Encounter two plan.',
  generation: 1,
  ...over,
});

/** A row an encounter wrote and left in `state`; `encounterSeq` undefined ⇒ an unstamped legacy row. */
function rowFrom(encounterSeq: number | undefined, state: DocumentSectionState, body = 'Encounter one plan.') {
  const row = DocumentSectionFactory.CreateDocumentSection({
    tenantId: TENANT,
    consultationId: CID,
    documentKey: 'soap_note',
    sectionKey: 'plan',
    title: 'Plan',
    idx: 1,
  });
  row.applyMachineContent(body, [{ kind: 'entity', start: 0, end: 3 }] as never);
  if (state === DocumentSectionState.CONFIRMED) row.applyClinicianContent(body, 'doctor-1');
  if (state === DocumentSectionState.LOCKED) row.lock();
  if (encounterSeq !== undefined) row.metaData = { encounterSeq, lastDeletion: { reason: 'old' } };
  return row;
}

function storeWith(row?: DocumentSectionEntity) {
  const repository = repositoryDouble();
  if (row) repository.rows.set(row.sectionKey, row);
  return { repository, store: new DocumentSectionStore(repository as never) };
}

describe('sectionEncounterSeq', () => {
  it('reads the stamp, and treats an unstamped row as encounter 1', () => {
    expect(sectionEncounterSeq(rowFrom(3, DocumentSectionState.PROVISIONAL))).toBe(3);
    expect(sectionEncounterSeq(rowFrom(undefined, DocumentSectionState.PROVISIONAL))).toBe(1);
  });
});

describe('applyFlushPatch — encounter scoping', () => {
  it('stamps the encounter on a row it creates', async () => {
    const { store, repository } = storeWith();
    const result = await store.applyFlushPatch(write({ encounterSeq: 2 }));
    expect(result.applied).toBe(true);
    expect(sectionEncounterSeq(repository.rows.get('plan')!)).toBe(2);
  });

  it('supersedes a LOCKED row an earlier encounter finalized — the new encounter starts the section fresh', async () => {
    const earlier = rowFrom(1, DocumentSectionState.LOCKED);
    const revisionBefore = earlier.revision;
    const { store, repository } = storeWith(earlier);

    const result = await store.applyFlushPatch(write({ encounterSeq: 2 }));

    expect(result.applied).toBe(true);
    const row = repository.rows.get('plan')!;
    expect(row.content).toBe('Encounter two plan.');
    expect(row.state).toBe(DocumentSectionState.PROVISIONAL);
    expect(row.lockedAt ?? null).toBeNull();
    expect(row.annotations ?? null).toBeNull();
    expect(sectionEncounterSeq(row)).toBe(2);
    expect((row.metaData as Record<string, unknown>).lastDeletion).toBeUndefined();
    // Revision stays monotonic so a client's revision gate still orders the patches.
    expect(row.revision).toBeGreaterThan(revisionBefore);
    expect(result.applied && result.patch.state).toBe('provisional');
  });

  it('an APPEND from a later encounter does not carry the earlier encounter body or its confirmation', async () => {
    const { store, repository } = storeWith(rowFrom(undefined, DocumentSectionState.CONFIRMED));

    const result = await store.applyFlushPatch(write({ encounterSeq: 2, mode: 'append', content: 'Review in two weeks.' }));

    expect(result.applied).toBe(true);
    const row = repository.rows.get('plan')!;
    expect(row.content).toBe('Review in two weeks.');
    expect(row.state).toBe(DocumentSectionState.PROVISIONAL);
    expect(row.confirmedAt ?? null).toBeNull();
    expect(row.confirmedBy ?? null).toBeNull();
  });

  it('a late flush from an EARLIER encounter never touches a row a later encounter owns', async () => {
    const later = rowFrom(2, DocumentSectionState.PROVISIONAL, 'Encounter two plan.');
    const { store, repository } = storeWith(later);

    const result = await store.applyFlushPatch(write({ encounterSeq: 1, content: 'Late encounter one text.' }));

    expect(result).toEqual({ applied: false, reason: 'stale-encounter' });
    expect(repository.updateWithVersion).not.toHaveBeenCalled();
    expect(repository.rows.get('plan')!.content).toBe('Encounter two plan.');
  });

  it('within one encounter a LOCKED row still refuses, and an append still accumulates', async () => {
    const locked = storeWith(rowFrom(2, DocumentSectionState.LOCKED));
    expect(await locked.store.applyFlushPatch(write({ encounterSeq: 2 }))).toEqual({ applied: false, reason: 'locked' });

    const open = storeWith(rowFrom(2, DocumentSectionState.PROVISIONAL, 'First part.'));
    const result = await open.store.applyFlushPatch(write({ encounterSeq: 2, mode: 'append', content: 'Second part.' }));
    expect(result.applied).toBe(true);
    expect(open.repository.rows.get('plan')!.content).toBe('First part.\n\nSecond part.');
  });

  it('an unstamped row read in encounter 1 is that encounter’s own row', async () => {
    const { store } = storeWith(rowFrom(undefined, DocumentSectionState.LOCKED));
    expect(await store.applyFlushPatch(write({ encounterSeq: 1 }))).toEqual({ applied: false, reason: 'locked' });
  });

  it('a write that names no encounter behaves exactly as before', async () => {
    const { store, repository } = storeWith(rowFrom(1, DocumentSectionState.LOCKED));
    expect(await store.applyFlushPatch(write())).toEqual({ applied: false, reason: 'locked' });
    expect(repository.updateWithVersion).not.toHaveBeenCalled();
  });
});

describe('readDocument — encounter scoping', () => {
  it('resumes only from the rows of the requested encounter', async () => {
    const { store } = storeWith(rowFrom(1, DocumentSectionState.LOCKED));
    const order = [{ key: 'plan', title: 'Plan' }];

    expect(await store.readDocument(TENANT, CID, 'soap_note', order, 2)).toBeNull();
    expect(await store.readDocument(TENANT, CID, 'soap_note', order, 1)).toEqual([{ title: 'Plan', content: 'Encounter one plan.' }]);
    // No encounter named ⇒ unchanged.
    expect(await store.readDocument(TENANT, CID, 'soap_note', order)).toEqual([{ title: 'Plan', content: 'Encounter one plan.' }]);
  });
});
