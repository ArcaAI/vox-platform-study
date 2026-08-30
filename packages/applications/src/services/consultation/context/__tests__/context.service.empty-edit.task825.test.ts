/**
 * TASK-825 — an EMPTY `ContextItem` edit must never commit over retained text.
 *
 * ## The defect this file pins
 *
 * `ContextItem` has NO plaintext `content` column, so `encryptedContent` is the
 * only persisted form of the body. `encryptStringToCiphertext` returns `null`
 * for `''`, so `encryptContentIntoEntity` returned before assigning — which
 * means `encryptedContent` never entered `entity.changes` and the UPDATE simply
 * omitted the column. `currentVersionNumber` and `updatedBy` ARE real columns
 * and had already moved by then, and an immutable `ContextItemVersion` row
 * recording the NEW (empty) body was already inserted. So the write committed,
 * the clinician got `200`, the history said the note was emptied — and the note
 * still held every word of the old text. Probed Prisma payload, pre-fix:
 *
 *   data = { currentVersionNumber: 4, updatedBy: 'doctor-1', version: {increment:1} }
 *   row.encryptedContent = <Buffer vault:v1:the-clinicians-summary>   ← retained
 *
 * Like TASK-820 this needs no outage: it reproduces against a fully WORKING
 * encryptor, which is why `workingTransit()` is used throughout.
 *
 * ## Why the disposition differs from TASK-820's
 *
 * `DocumentSection` is a fixed slot in a document template with no per-section
 * delete, so "empty" is the only way to say *nothing to report here* — TASK-820
 * correctly PERSISTED the clearing. A `ContextItem` is a discrete row with a
 * first-class `DELETE` (soft delete), and `addContext` ALREADY refuses an empty
 * body for a non-media type (*"Content is required for non-media types"*), which
 * `ContextItemEntity.validate()` states as a structural invariant. Clearing here
 * would persist a row the CREATE path would have refused to create. So the edit
 * is REFUSED for a `requiresContent` type, and CLEARED for a media type, where
 * an absent body is legitimate.
 *
 * ## What is real here, and what is a double
 *
 * The REAL `ContextService`, the REAL `ContextItemRepository` (production
 * `encryptContentIntoEntity` and through it the real `encryptStringToCiphertext`),
 * and the REAL `ContextItemEntityMapper`. Only the Prisma DELEGATE is doubled,
 * so every assertion below is on the payload Prisma was actually handed and on
 * the column snapshot that payload produced. Stubbing `encryptContentIntoEntity`
 * — the shape the sibling suite uses — would assert the very thing under test;
 * that is the false assurance TASK-820 §2 documents.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  ContextItemRepository,
  ContextItemVersionRepository,
  type ContextItemVersionEntity,
  ContextItemType,
  ContextItemSource,
} from '@arcaai/domains';
import { ContextService } from '../context.service';

const TENANT = 'tenant-825';
const ITEM = 'ctx-825';
const USER = 'doctor-1';

/** The ciphertext already on the row — what the lost deletion silently keeps. */
const EXISTING_CIPHERTEXT = Buffer.from('vault:v1:the-clinicians-summary', 'utf8');

/**
 * A WORKING Transit stand-in producing a real `vault:vN:<b64>` string, so the
 * real `encryptStringToCiphertext` and the real key-version parser both run.
 * Deliberately working: this defect needs no outage.
 */
function workingTransit() {
  return {
    encrypt: async (plaintext: Buffer) => `vault:v3:${plaintext.toString('base64')}`,
    decrypt: async (ciphertext: string) => Buffer.from(ciphertext.split(':')[2] ?? '', 'base64'),
    getPhiTransitKeyName: () => 'hope-phi',
  };
}

/** The persisted columns of the ContextItem row. */
type Row = Record<string, unknown> & {
  version: number;
  encryptedContent: Buffer | null;
  contentKeyVersion: number | null;
  currentVersionNumber: number;
};

function seedRow(type: ContextItemType): Row {
  return {
    id: ITEM,
    version: 5,
    tenantId: TENANT,
    consultationId: 'cons-825',
    type,
    source: ContextItemSource.USER,
    currentVersionNumber: 3,
    // Reconstituted from COLUMNS: there is no `content` column to hydrate, so
    // the ciphertext is the only body the row carries.
    content: null,
    encryptedContent: EXISTING_CIPHERTEXT,
    contentKeyVersion: 1,
    mediaId: null,
    dnaWritingStyleId: null,
    kindKey: null,
    documentKey: null,
    contextSchemaVersionId: null,
    metaData: null,
    qdrantSynced: true,
    qdrantSyncedAt: new Date('2026-08-01T00:00:00Z'),
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: USER,
    updatedBy: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  } as Row;
}

function harness(type: ContextItemType = ContextItemType.CASE_NOTE) {
  const store = { row: seedRow(type) };
  /** Every `data` object Prisma was handed — the real persisted payload. */
  const payloads: Record<string, unknown>[] = [];

  const delegate = {
    findUnique: vi.fn(async () => ({ ...store.row })),
    findFirst: vi.fn(async () => ({ ...store.row })),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      payloads.push(data);
      if (store.row.version !== where.version) return { count: 0 };
      const { version: _increment, ...columns } = data;
      store.row = { ...store.row, ...columns, version: store.row.version + 1 } as Row;
      return { count: 1 };
    }),
  };

  const uow = { getDatabaseService: () => ({ contextItem: delegate }) } as never;
  const contextItemRepository = new ContextItemRepository(uow);

  // The version table is doubled at the REPOSITORY level (its persistence is
  // not what this file is about) but `encryptFieldsIntoEntity` stays REAL, so
  // the snapshot's own ciphertext is genuine.
  const versionRepository = new ContextItemVersionRepository(uow);
  const versions: ContextItemVersionEntity[] = [];
  Object.assign(versionRepository, {
    getLatestVersionNumber: vi.fn(async () => 3),
    create: vi.fn(async (entity: ContextItemVersionEntity) => {
      versions.push(entity);
      return entity;
    }),
  });

  const cls = {
    get: (key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: USER } : undefined),
    set: vi.fn(),
  };

  const service = new ContextService(
    contextItemRepository,
    versionRepository,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { emit: vi.fn() } as never,
    cls as never,
    workingTransit() as never,
  );

  return { service, store, payloads, versions, updateMany: delegate.updateMany };
}

// ---------------------------------------------------------------------------

describe('TASK-825 — an empty ContextItem edit never commits over retained text', () => {
  it('REFUSES an empty edit on a note, and writes NOTHING at all', async () => {
    const { service, store, versions, updateMany } = harness(ContextItemType.CASE_NOTE);

    await expect(service.updateContext(ITEM, { content: '', expectedVersion: 5 } as never)).rejects.toBeInstanceOf(BadRequestException);

    // Nothing moved. Pre-fix EVERY one of these failed: the write committed,
    // `currentVersionNumber` advanced to 4, `updatedBy` was stamped, an
    // immutable v4 snapshot recording an empty body was inserted — and the old
    // ciphertext stayed on the row the whole time.
    expect(updateMany).not.toHaveBeenCalled();
    expect(versions).toHaveLength(0);
    expect(store.row.encryptedContent).toEqual(EXISTING_CIPHERTEXT);
    expect(store.row.contentKeyVersion).toBe(1);
    expect(store.row.currentVersionNumber).toBe(3);
    expect(store.row.version).toBe(5);
  });

  it('the refusal is the CREATE path’s rule, not a new one: same message, same scope', async () => {
    // `addContext` already throws *"Content is required for non-media types"*.
    // The rule was simply absent on the update path — the asymmetry IS the bug.
    const { service } = harness(ContextItemType.WORKNOTE);

    await expect(service.updateContext(ITEM, { content: '', expectedVersion: 5 } as never)).rejects.toThrow(/Content is required for non-media types/);
  });

  it('MEDIA item: an empty edit IS allowed, and it clears the persisted ciphertext', async () => {
    // An ATTACHMENT legitimately carries no body (`requiresContent` is false),
    // so here the empty write is accepted — and it must actually CLEAR, which is
    // the repository-seam half of the fix. Pre-fix this failed on the very first
    // assertion with `<Buffer vault:v1:the-clinicians-summary>`: the bug
    // committing, verbatim.
    const { service, store, payloads } = harness(ContextItemType.ATTACHMENT);

    await service.updateContext(ITEM, { content: '', expectedVersion: 5 } as never);

    expect(store.row.encryptedContent).toBeNull();
    expect(store.row.contentKeyVersion).toBeNull();
    // Asserted on the PRISMA PAYLOAD, not just the entity: the clearing null has
    // to survive `ContextItemEntityMapper` to reach the column at all.
    expect(payloads[0]).toMatchObject({ encryptedContent: null, contentKeyVersion: null });
  });

  it('a NON-empty edit still stores its new ciphertext (the ordinary path is untouched)', async () => {
    const { service, store } = harness(ContextItemType.CASE_NOTE);

    await service.updateContext(ITEM, { content: 'Revised: viral URI, no antibiotic.', expectedVersion: 5 } as never);

    expect(store.row.encryptedContent).not.toBeNull();
    expect(store.row.encryptedContent).not.toEqual(EXISTING_CIPHERTEXT);
    // Proves the REAL encrypt path ran: `vault:v3:` parsed into the key version.
    expect(store.row.contentKeyVersion).toBe(3);
    expect(store.row.currentVersionNumber).toBe(4);
  });

  it('a metadata-only edit leaves the body alone (undefined must never read as a deletion)', async () => {
    // The `undefined`/`null` no-op is load-bearing: a row reconstituted from
    // columns has no `content` to hydrate, so treating absence as a deletion
    // would blank the body of every item touched by a write that never
    // mentioned it.
    const { service, store, payloads } = harness(ContextItemType.CASE_NOTE);

    await service.updateContext(ITEM, { dnaWritingStyleId: 'style-2', expectedVersion: 5 } as never);

    expect(store.row.encryptedContent).toEqual(EXISTING_CIPHERTEXT);
    expect(store.row.contentKeyVersion).toBe(1);
    expect(payloads[0]).not.toHaveProperty('encryptedContent');
  });
});
