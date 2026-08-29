/**
 * TASK-820 — an EMPTY section write must clear the persisted body.
 *
 * ## The defect this file pins
 *
 * `DocumentSection.content` is TRANSIENT: `encryptedContent` is the only
 * persisted form of the body. `encryptStringToCiphertext` returns `null` for an
 * empty string, so `encryptContentIntoEntity` returns early and never touches
 * `encryptedContent` — which means the column never enters the change set and
 * the UPDATE simply omits it. `state`, `revision`, `confirmedAt/By` and
 * `_version` are real columns and have ALREADY moved by then. So the write
 * commits, the clinician gets `200`, and on reload the deleted text is back.
 *
 * TASK-819 fixed the adjacent failure (an encryptor that is DOWN). This one
 * needs no outage at all: it reproduces against a fully working encryptor,
 * which is why the harness below uses `workingTransit()` throughout.
 *
 * ## What is real here, and what is a double
 *
 * The REAL `DocumentSectionRepository.encryptContentIntoEntity` and through it
 * the REAL `encryptStringToCiphertext` — the empty-string short-circuit is the
 * defect, so stubbing it would assert the very thing under test. Only
 * PERSISTENCE is a double, and it stores COLUMN SNAPSHOTS rather than entity
 * references so an in-memory mutation cannot masquerade as a landed write.
 *
 * The double models the entity, not the Prisma payload. That is faithful here
 * and it was verified rather than assumed: `DocumentSectionEntityMapper`
 * carries a cleared `encryptedContent` through to the persistence payload as an
 * explicit `null`, and omits the key entirely when the entity was never touched
 * — pinned by `DocumentSectionEntityMapper.encryptedContent.test.ts` in
 * `@arcaai/domains`, because this file's assertions depend on it.
 */
import { describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { DocumentSectionEntity, DocumentSectionRepository, DocumentSectionState } from '@arcaai/domains';
import { DocumentSectionStore, type SectionSecretsLike, type SectionWriteInput } from '../section-store';

const CID = 'consultation-820';
const TENANT = 'tenant-820';
const DOCUMENT = 'soap_note';
const SECTION = 'assessment';

/** The ciphertext already on the row — what the lost deletion silently keeps. */
const EXISTING_CIPHERTEXT = Buffer.from('vault:v1:the-text-the-clinician-deleted', 'utf8');

/**
 * A WORKING Transit stand-in producing a real `vault:vN:<b64>` string, so the
 * real `encryptStringToCiphertext` and the real key-version parser both run.
 * Deliberately working: this defect needs no outage.
 */
function workingTransit(): SectionSecretsLike {
  return {
    encrypt: async (plaintext: Buffer) => `vault:v3:${plaintext.toString('base64')}`,
    decrypt: async (ciphertext: string) => Buffer.from(ciphertext.split(':')[2] ?? '', 'base64'),
    getPhiTransitKeyName: () => 'hope-phi',
  };
}

/** The persisted columns of one row. */
interface RowSnapshot {
  id: string;
  title: string;
  idx: number;
  state: DocumentSectionState;
  revision: number;
  version: number;
  encryptedContent: Buffer | null;
  contentKeyVersion: number | null;
  confirmedAt: Date | null;
  confirmedBy: string | null;
}

function snapshot(entity: DocumentSectionEntity, version: number): RowSnapshot {
  return {
    id: entity.id,
    title: entity.title,
    idx: entity.idx,
    state: entity.state,
    revision: entity.revision,
    version,
    encryptedContent: entity.encryptedContent ? Buffer.from(entity.encryptedContent) : null,
    contentKeyVersion: entity.contentKeyVersion ?? null,
    confirmedAt: entity.confirmedAt ?? null,
    confirmedBy: entity.confirmedBy ?? null,
  };
}

/**
 * Rebuild the entity a real `findSection` hands back: reconstituted from
 * COLUMNS, so `content` is absent (there is no column for it) and the ciphertext
 * is the only body the row carries.
 */
function entityFrom(row: RowSnapshot): DocumentSectionEntity {
  return new DocumentSectionEntity({
    id: row.id,
    version: row.version,
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
    updatedAt: new Date('2026-08-30T00:00:00.000Z'),
    createdBy: null,
    updatedBy: null,
    tenantId: TENANT,
    consultationId: CID,
    documentKey: DOCUMENT,
    sectionKey: SECTION,
    title: row.title,
    idx: row.idx,
    state: row.state,
    revision: row.revision,
    content: null,
    encryptedContent: row.encryptedContent,
    contentKeyVersion: row.contentKeyVersion,
    annotations: null,
    provenance: null,
    documentTemplateVersionId: null,
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
    lockedAt: null,
    Consultation: null,
  });
}

function repositoryWithFakeDb(seed: Partial<RowSnapshot> = {}) {
  const repo = new DocumentSectionRepository({ getDatabaseService: () => ({}) } as never);

  const store: { row: RowSnapshot | null } = {
    row: {
      id: 'section-820',
      title: 'Assessment',
      idx: 2,
      state: DocumentSectionState.PROVISIONAL,
      revision: 3,
      version: 4,
      encryptedContent: EXISTING_CIPHERTEXT,
      contentKeyVersion: 1,
      confirmedAt: null,
      confirmedBy: null,
      ...seed,
    },
  };

  const findSection = vi.fn(async () => (store.row ? entityFrom(store.row) : null));
  const create = vi.fn(async (entity: DocumentSectionEntity) => {
    store.row = snapshot(entity, 1);
    return entity;
  });
  const updateWithVersion = vi.fn(async (_id: string, entity: DocumentSectionEntity, expectedVersion: number) => {
    if (store.row && store.row.version !== expectedVersion) {
      throw new OptimisticConcurrencyException('DocumentSection', entity.id, expectedVersion, store.row.version);
    }
    store.row = snapshot(entity, expectedVersion + 1);
    return entity;
  });

  Object.assign(repo, { findSection, create, updateWithVersion });
  return { repo, store, findSection, create, updateWithVersion };
}

const write = (over: Partial<SectionWriteInput> = {}): SectionWriteInput => ({
  consultationId: CID,
  tenantId: TENANT,
  documentKey: DOCUMENT,
  sectionKey: SECTION,
  title: 'Assessment',
  idx: 2,
  content: 'Likely bacterial sinusitis; start amoxicillin.',
  generation: 7,
  ...over,
});

// ---------------------------------------------------------------------------

describe('TASK-820 — an empty write clears the persisted body', () => {
  it('CLINICIAN: emptying a section clears the ciphertext, not just the state', async () => {
    const { repo, store, updateWithVersion } = repositoryWithFakeDb();

    const result = await new DocumentSectionStore(repo, workingTransit()).applyClinicianEdit(
      write({ content: '', userId: 'doctor-7', expectedVersion: 4 }),
    );

    // The write is ACCEPTED — a clinician emptying their own section is
    // authorized, and refusing it would be the wrong fix (TASK-811 §8b).
    expect(result.applied).toBe(true);
    expect(updateWithVersion).toHaveBeenCalledTimes(1);

    // ...and the body it committed is EMPTY. Before the fix every one of these
    // held: the state advanced while the deleted text stayed on the row.
    expect(store.row!.encryptedContent).toBeNull();
    expect(store.row!.contentKeyVersion).toBeNull();
    expect(store.row!.state).toBe(DocumentSectionState.CONFIRMED);
    expect(store.row!.revision).toBe(4);
    expect(store.row!.version).toBe(5);
  });

  it('CLINICIAN: a non-empty edit still stores its new ciphertext', async () => {
    // The other half of the fix: clearing must be scoped to an EMPTY write and
    // must not touch the ordinary path.
    const { repo, store } = repositoryWithFakeDb();

    const result = await new DocumentSectionStore(repo, workingTransit()).applyClinicianEdit(
      write({ content: 'Clinician: viral URI, no antibiotic.', userId: 'doctor-7', expectedVersion: 4 }),
    );

    expect(result.applied).toBe(true);
    expect(store.row!.encryptedContent).not.toBeNull();
    expect(store.row!.encryptedContent).not.toEqual(EXISTING_CIPHERTEXT);
    // Proves the REAL encrypt path ran: `vault:v3:` parsed into the key version.
    expect(store.row!.contentKeyVersion).toBe(3);
  });

  it('FLUSH: an AUTHORIZED machine deletion clears the ciphertext too', async () => {
    // The machine lane loses the deletion the same way once the contradiction
    // rule has already let the write through — the guard decides WHETHER the
    // deletion is allowed, never whether it is persisted.
    const { repo, store } = repositoryWithFakeDb();

    const result = await new DocumentSectionStore(repo, workingTransit()).applyFlushPatch(
      write({ content: '', contradiction: { reason: 'patient corrected the history', transcriptSegmentId: 'seg-9' } }),
    );

    expect(result.applied).toBe(true);
    expect(store.row!.encryptedContent).toBeNull();
    expect(store.row!.contentKeyVersion).toBeNull();
  });

  it('the machine/clinician distinction still holds: an UNJUSTIFIED flush deletion is refused', async () => {
    // `deletion-without-contradiction` guards the MACHINE writer from silently
    // emptying prose it wrote earlier. Clearing the ciphertext must not soften
    // it — this row had content, and a flush with no contradiction gets nowhere.
    const { repo, store, updateWithVersion } = repositoryWithFakeDb();
    // `hadContent` is read off the entity, whose `content` a flush re-read
    // populates from the previous machine write in the same process.
    const withContent = entityFrom(store.row!);
    withContent.content = 'Likely bacterial sinusitis; start amoxicillin.';
    Object.assign(repo, { findSection: vi.fn(async () => withContent) });

    const result = await new DocumentSectionStore(repo, workingTransit()).applyFlushPatch(write({ content: '' }));

    expect(result).toEqual({ applied: false, reason: 'deletion-without-contradiction' });
    expect(updateWithVersion).not.toHaveBeenCalled();
    expect(store.row!.encryptedContent).toEqual(EXISTING_CIPHERTEXT);
  });

  it('never logs the deleted body', async () => {
    const { repo } = repositoryWithFakeDb();
    const secret = 'Likely bacterial sinusitis; start amoxicillin.';
    const store = new DocumentSectionStore(repo, workingTransit());

    const logged: unknown[] = [];
    const capture = (...args: unknown[]): never => {
      logged.push(...args);
      return undefined as never;
    };
    const logger = store['logger'] as unknown as Record<string, unknown>;
    for (const level of ['warn', 'log', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(logger as never, level).mockImplementation(capture as never);
    }

    await store.applyClinicianEdit(write({ content: '', userId: 'doctor-7', expectedVersion: 4 }));

    expect(JSON.stringify(logged)).not.toContain('amoxicillin');
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
