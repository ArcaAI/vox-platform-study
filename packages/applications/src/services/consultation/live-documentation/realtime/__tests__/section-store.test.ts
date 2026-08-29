/**
 * TASK-811 tasks 8, 9 and 12 — per-section state, per-section OCC, the deletion
 * rule, and the `section.patch` contract.
 *
 * The headline case is `concurrent flush + clinician edit`: it is the reason
 * `DocumentSection` is a child table at all, so if it is not proven here the
 * design argument is unbacked.
 */
import { describe, it, expect, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { DocumentSectionFactory, DocumentSectionState, type DocumentSectionEntity } from '@arcaai/domains';
import { DocumentSectionStore, type SectionWriteInput } from '../section-store';
import { SECTION_ANNOTATION_KINDS } from '../dto/section-patch.dto';

const CID = 'consultation-811';
const TENANT = 'tenant-811';

/**
 * An in-memory `DocumentSectionRepository` double whose `updateWithVersion`
 * implements a REAL compare-and-set — the whole point of these tests is that the
 * CAS is exercised, not stubbed away.
 */
function repositoryDouble() {
  const rows = new Map<string, DocumentSectionEntity>();
  const key = (documentKey: string, sectionKey: string) => `${documentKey}::${sectionKey}`;

  return {
    rows,
    findSection: vi.fn(async (_tenantId: string, _cid: string, documentKey: string, sectionKey: string) => rows.get(key(documentKey, sectionKey)) ?? null),
    create: vi.fn(async (entity: DocumentSectionEntity) => {
      rows.set(key(entity.documentKey, entity.sectionKey), entity);
      return entity;
    }),
    updateWithVersion: vi.fn(async (_id: string, entity: DocumentSectionEntity, expectedVersion: number) => {
      const stored = rows.get(key(entity.documentKey, entity.sectionKey));
      if (stored && stored.version !== expectedVersion) {
        throw new OptimisticConcurrencyException('DocumentSection', entity.id, expectedVersion, stored.version);
      }
      // A successful CAS bumps the DB-owned version, as `updateWithVersion` does.
      (entity as unknown as { _version: number })._version = expectedVersion + 1;
      rows.set(key(entity.documentKey, entity.sectionKey), entity);
      return entity;
    }),
    encryptContentIntoEntity: vi.fn(async () => undefined),
  };
}

const write = (over: Partial<SectionWriteInput> = {}): SectionWriteInput => ({
  consultationId: CID,
  tenantId: TENANT,
  documentKey: 'soap_note',
  sectionKey: 'assessment',
  title: 'Assessment',
  idx: 2,
  content: 'Likely viral URI.',
  generation: 1,
  ...over,
});

const storeWith = (repo: ReturnType<typeof repositoryDouble>) => new DocumentSectionStore(repo as never, undefined);

// ---------------------------------------------------------------------------
// Task 8 — per-document, per-section state under concurrent flush + edit
// ---------------------------------------------------------------------------

describe('task 8 — per-section state and per-section OCC', () => {
  it('creates a section on first write and promotes it EMPTY -> PROVISIONAL', async () => {
    const repo = repositoryDouble();
    const result = await storeWith(repo).applyFlushPatch(write());

    expect(result.applied).toBe(true);
    expect(repo.rows.get('soap_note::assessment')?.state).toBe(DocumentSectionState.PROVISIONAL);
  });

  it('THE INVARIANT: a flush never overwrites a CONFIRMED section', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);

    await store.applyFlushPatch(write());
    await store.applyClinicianEdit(write({ content: 'Clinician: bacterial sinusitis.', userId: 'doctor-7' }));

    const refused = await store.applyFlushPatch(write({ content: 'Model changed its mind.', generation: 2 }));

    expect(refused).toEqual({ applied: false, reason: 'confirmed-no-overwrite' });
    expect(repo.rows.get('soap_note::assessment')?.content).toBe('Clinician: bacterial sinusitis.');
  });

  it('CONCURRENT flush + clinician edit: the compare-and-set makes the flush lose, and it does NOT retry', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());

    // Both writers read the same version…
    const stored = repo.rows.get('soap_note::assessment')!;
    const sharedVersion = stored.version;

    // …the clinician commits first, bumping the version out from under the flush.
    const clinicianCopy = repo.rows.get('soap_note::assessment')!;
    clinicianCopy.applyClinicianContent('Clinician wins.', 'doctor-7');
    await repo.updateWithVersion(clinicianCopy.id, clinicianCopy, sharedVersion);

    // Now the flush's own CAS, issued against the version it read.
    const flushEntity = DocumentSectionFactory.CreateDocumentSection({
      tenantId: TENANT,
      consultationId: CID,
      documentKey: 'soap_note',
      sectionKey: 'assessment',
      title: 'Assessment',
      idx: 2,
    });
    flushEntity.applyMachineContent('Flush loses.');
    await expect(repo.updateWithVersion(flushEntity.id, flushEntity, sharedVersion)).rejects.toBeInstanceOf(OptimisticConcurrencyException);

    expect(repo.rows.get('soap_note::assessment')?.content).toBe('Clinician wins.');
  });

  it('reports `occ-conflict` — and never re-reads and rewrites, which would defeat the check', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());
    // Force a drift the store cannot see coming.
    repo.updateWithVersion.mockRejectedValueOnce(new OptimisticConcurrencyException('DocumentSection', 'x', 1, 2));

    const result = await store.applyFlushPatch(write({ content: 'Second flush.', generation: 2 }));

    expect(result).toEqual({ applied: false, reason: 'occ-conflict' });
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1); // no retry
  });

  it('TWO DOCUMENTS never contend: writing `discharge_summary` leaves `soap_note` untouched', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);

    const [soap, discharge] = await Promise.all([
      store.applyFlushPatch(write({ documentKey: 'soap_note', content: 'SOAP assessment.' })),
      store.applyFlushPatch(write({ documentKey: 'discharge_summary', content: 'Discharge assessment.' })),
    ]);

    expect(soap.applied).toBe(true);
    expect(discharge.applied).toBe(true);
    expect(repo.rows.get('soap_note::assessment')?.content).toBe('SOAP assessment.');
    expect(repo.rows.get('discharge_summary::assessment')?.content).toBe('Discharge assessment.');
  });

  it('a LOCKED section rejects both writers', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());
    repo.rows.get('soap_note::assessment')!.lock();

    await expect(store.applyFlushPatch(write({ generation: 2 }))).resolves.toEqual({ applied: false, reason: 'locked' });
    await expect(store.applyClinicianEdit(write({ userId: 'doctor-7' }))).resolves.toEqual({ applied: false, reason: 'locked' });
  });

  it('discards an OUT-OF-ORDER generation — a late flush cannot replace fresher content', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);

    await store.applyFlushPatch(write({ content: 'Generation 4 content.', generation: 4 }));
    const late = await store.applyFlushPatch(write({ content: 'Generation 3, arriving late.', generation: 3 }));

    expect(late).toEqual({ applied: false, reason: 'stale-generation' });
    expect(repo.rows.get('soap_note::assessment')?.content).toBe('Generation 4 content.');
  });
});

// ---------------------------------------------------------------------------
// Task 9 — deletion requires a transcript contradiction
// ---------------------------------------------------------------------------

describe('task 9 — a deletion must point at a transcript contradiction', () => {
  it('REFUSES a flush that empties a populated section with no reason', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write({ content: 'Patient reports chest pain.' }));

    const refused = await store.applyFlushPatch(write({ content: '', generation: 2 }));

    expect(refused).toEqual({ applied: false, reason: 'deletion-without-contradiction' });
    expect(repo.rows.get('soap_note::assessment')?.content).toBe('Patient reports chest pain.');
  });

  it('ACCEPTS the same deletion when it names what contradicts it', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write({ content: 'Patient reports chest pain.' }));

    const accepted = await store.applyFlushPatch(
      write({ content: '', generation: 2, contradiction: { transcriptSegmentId: 't_0912', reason: 'patient corrected: no chest pain' } }),
    );

    expect(accepted.applied).toBe(true);
    const row = repo.rows.get('soap_note::assessment')!;
    expect(row.content).toBe('');
    expect((row.metaData as Record<string, Record<string, unknown>>).lastDeletion).toMatchObject({ transcriptSegmentId: 't_0912' });
  });

  it('an ALWAYS-EMPTY section needs no reason — `empty` is a normal state, not a deletion', async () => {
    const repo = repositoryDouble();
    const result = await storeWith(repo).applyFlushPatch(write({ content: '' }));

    expect(result.applied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 12 — the `section.patch` contract
// ---------------------------------------------------------------------------

describe('task 12 — the section.patch payload contract (§2b)', () => {
  it('carries documentKey / sectionKey / revision / state / annotations / provenance', async () => {
    const repo = repositoryDouble();
    const result = await storeWith(repo).applyFlushPatch(
      write({
        documentTemplateVersionId: 'dtv-1',
        annotations: [{ kind: 'entity', start: 12, end: 21, type: 'MEDICATION' }],
        provenance: [{ transcriptSegmentId: 't_0912', transcriptStart: 40, transcriptEnd: 61 }],
      }),
    );

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.patch).toMatchObject({
      event: 'section.patch',
      consultationId: CID,
      documentKey: 'soap_note',
      sectionKey: 'assessment',
      title: 'Assessment',
      idx: 2,
      revision: 1,
      state: 'provisional',
      content: 'Likely viral URI.',
      annotations: [{ kind: 'entity', start: 12, end: 21, type: 'MEDICATION' }],
      provenance: [{ transcriptSegmentId: 't_0912', transcriptStart: 40, transcriptEnd: 61 }],
      documentTemplateVersionId: 'dtv-1',
    });
    expect(() => new Date(result.patch.updatedAt).toISOString()).not.toThrow();
  });

  it('annotation offsets are SECTION-LOCAL: they index `content`, not a concatenated document', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);

    // Grow an EARLIER section. Under the old global-offset contract this would
    // have invalidated every offset after it; here it cannot, because the
    // annotation indexes its own section's content.
    await store.applyFlushPatch(write({ sectionKey: 'subjective', idx: 0, title: 'Subjective', content: 'A'.repeat(500) }));
    const result = await store.applyFlushPatch(write({ annotations: [{ kind: 'entity', start: 0, end: 6, type: 'CONDITION' }] }));

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    const { content, annotations } = result.patch;
    expect(content.slice(annotations![0].start, annotations![0].end)).toBe('Likely');
  });

  it('revision advances monotonically so a client can discard an out-of-order patch', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);

    const first = await store.applyFlushPatch(write({ content: 'One.' }));
    const second = await store.applyFlushPatch(write({ content: 'Two.', generation: 2 }));

    expect(first.applied && first.patch.revision).toBe(1);
    expect(second.applied && second.patch.revision).toBe(2);
  });

  it('declares exactly the three annotation kinds the live plane produces', () => {
    expect(SECTION_ANNOTATION_KINDS).toEqual(['entity', 'groundedness', 'flagged']);
  });

  it('refuses cleanly when no repository is wired rather than pretending the write happened', async () => {
    const store = new DocumentSectionStore(undefined, undefined);
    await expect(store.applyFlushPatch(write())).resolves.toEqual({ applied: false, reason: 'unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Lane D — the CALLER-SUPPLIED compare-and-set operand
// ---------------------------------------------------------------------------

/**
 * `applyClinicianEdit` was written when its only caller was a test: it read the
 * row and then compare-and-set against the version IT had just read, which is a
 * read-modify-write, not a precondition. That is sound for an in-process writer
 * with no opinion about what it is overwriting, and WRONG the moment the writer
 * is an HTTP client holding an `If-Match` from an earlier read — the store would
 * re-read past the client's stale view and overwrite a flush the client never saw.
 *
 * So the operand becomes an INPUT when the caller has one. Absent (every existing
 * caller) the behaviour is byte-identical to before.
 */
describe('lane D — a clinician edit compare-and-sets against the CALLER’s version', () => {
  it('LOSES when the caller’s expectedVersion is stale — a flush landed after the client read', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);

    await store.applyFlushPatch(write());
    const readVersion = repo.rows.get('soap_note::assessment')!.version;
    // A flush lands between the clinician's read and their submit.
    await store.applyFlushPatch(write({ content: 'Flush wrote this after the client read.', generation: 2 }));

    const stale = await store.applyClinicianEdit(write({ content: 'Clinician text.', userId: 'doctor-7', expectedVersion: readVersion }));

    expect(stale).toEqual({ applied: false, reason: 'occ-conflict' });
    // The operand actually issued to the CAS is the CALLER's stale version, not the
    // one the store just re-read. Asserted on the call rather than on the double's
    // row because `findSection` hands back the stored object BY REFERENCE, so an
    // in-place mutation shows up there even when the write was rejected — an
    // artifact of the fixture, not of the store.
    const [, , issuedVersion] = repo.updateWithVersion.mock.calls.at(-1)!;
    expect(issuedVersion).toBe(readVersion);
  });

  it('APPLIES when the caller’s expectedVersion is current', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());

    const current = repo.rows.get('soap_note::assessment')!.version;
    const applied = await store.applyClinicianEdit(write({ content: 'Clinician text.', userId: 'doctor-7', expectedVersion: current }));

    expect(applied.applied).toBe(true);
    expect(repo.rows.get('soap_note::assessment')?.content).toBe('Clinician text.');
    expect(repo.rows.get('soap_note::assessment')?.state).toBe(DocumentSectionState.CONFIRMED);
  });

  it('with NO expectedVersion behaves exactly as before — read-modify-write', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());
    await store.applyFlushPatch(write({ content: 'Flush 2.', generation: 2 }));

    const applied = await store.applyClinicianEdit(write({ content: 'Clinician text.', userId: 'doctor-7' }));

    expect(applied.applied).toBe(true);
    expect(repo.rows.get('soap_note::assessment')?.content).toBe('Clinician text.');
  });
});
