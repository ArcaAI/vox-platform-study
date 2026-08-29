/**
 * TASK-819 — a section write whose content cannot be encrypted must not commit.
 *
 * ## The defect this file pins
 *
 * `DocumentSection.content` is TRANSIENT: there is no plaintext column, and
 * `encryptedContent` is the only persisted form. `revision`, `state`,
 * `confirmedAt`/`confirmedBy` and `_version` are all real columns, and all of
 * them are already mutated by `applyMachineContent` / `applyClinicianContent`
 * BEFORE the encryptor runs. So a swallowed encryption failure commits the state
 * transition and the bumped revision over the PREVIOUS ciphertext, and answers
 * the clinician `200 OK` while their text is gone.
 *
 * ## Why the outage here is real rather than mocked
 *
 * A test that stubs `encryptContentIntoEntity` to reject proves only that the
 * handler runs when something rejects — it asserts the very outcome it is
 * supposed to discover. So nothing on the encryption path is stubbed here:
 *
 *   - a REAL `VaultSecretsProvider`, pointed at a closed port, whose `boot()` is
 *     asserted to genuinely fail against a real socket;
 *   - the REAL `SecretsService` in front of it;
 *   - the REAL `DocumentSectionRepository.encryptContentIntoEntity`, and through
 *     it the real `encryptStringToCiphertext` (which is also what makes the
 *     no-content short-circuit real rather than assumed).
 *
 * Only PERSISTENCE is a double — and it has to be, because "the row was left
 * exactly as it was" is the assertion. It stores COLUMN SNAPSHOTS rather than
 * entity references, so a write that never reached `updateWithVersion` cannot
 * appear to have landed just because the store mutated an object in memory.
 */
import { describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { DocumentSectionEntity, DocumentSectionRepository, DocumentSectionState } from '@arcaai/domains';
import { SecretsService } from '../../../../baseServices/_meta/secrets';
import { VaultSecretsProvider } from '../../../../baseServices/_meta/secrets/providers/vault-secrets.provider';
import { DocumentSectionStore, type SectionSecretsLike, type SectionWriteInput } from '../section-store';

const CID = 'consultation-819';
const TENANT = 'tenant-819';
const DOCUMENT = 'soap_note';
const SECTION = 'assessment';

/** The ciphertext already on the row — what a swallowed failure silently keeps. */
const EXISTING_CIPHERTEXT = Buffer.from('vault:v1:the-clinician-earlier-text', 'utf8');

// ---------------------------------------------------------------------------
// A genuinely unavailable encryptor
// ---------------------------------------------------------------------------

/**
 * Port 1 is reserved (tcpmux) and never listening, so a connection to it is
 * refused by the kernel immediately — a real transport failure, not a timeout,
 * and no network egress.
 */
const CLOSED_PORT_ADDR = 'http://127.0.0.1:1';

function deadVault(): { provider: VaultSecretsProvider; secrets: SecretsService } {
  const provider = new VaultSecretsProvider({
    addr: CLOSED_PORT_ADDR,
    roleId: 'role-819',
    secretId: 'secret-819',
    kvMount: 'secret',
    kvPrefix: 'hope',
    transitMount: 'transit',
    transitKey: 'hope-globalsetting',
    requestTimeoutMs: 250,
  });
  return { provider, secrets: new SecretsService(provider as never) };
}

/**
 * A working Transit stand-in for the happy-path guard: it produces a REAL
 * `vault:vN:<b64>` string, so the assertions still run through the real
 * `encryptStringToCiphertext` and the real key-version parser.
 */
function workingTransit(): SectionSecretsLike {
  return {
    encrypt: async (plaintext: Buffer) => `vault:v3:${plaintext.toString('base64')}`,
    decrypt: async (ciphertext: string) => Buffer.from(ciphertext.split(':')[2] ?? '', 'base64'),
    getPhiTransitKeyName: () => 'hope-phi',
  };
}

// ---------------------------------------------------------------------------
// A real repository whose PERSISTENCE (only) is a double
// ---------------------------------------------------------------------------

/** The persisted columns of one row — everything a swallowed failure would move. */
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
 * Rebuild the entity a real `findSection` would hand back: reconstituted from
 * COLUMNS, so `content` is absent (there is no column for it) and no in-memory
 * mutation from an earlier attempt can leak into the next read.
 */
function entityFrom(row: RowSnapshot): DocumentSectionEntity {
  return new DocumentSectionEntity({
    id: row.id,
    version: row.version,
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    updatedAt: new Date('2026-08-29T00:00:00.000Z'),
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

/**
 * A real `DocumentSectionRepository` — so `encryptContentIntoEntity` is the
 * production method — with only the three DB-touching calls replaced.
 */
function repositoryWithFakeDb(seed?: Partial<RowSnapshot>) {
  const repo = new DocumentSectionRepository({ getDatabaseService: () => ({}) } as never);

  const store: { row: RowSnapshot | null } = { row: null };
  if (seed !== undefined) {
    store.row = {
      id: 'section-819',
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
    };
  }

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

describe('TASK-819 — an unencryptable write does not commit', () => {
  it('the encryptor really is unavailable: boot() fails against a closed port', async () => {
    // Establishes that everything below is reacting to an absent dependency
    // rather than to a stub that was told to reject.
    const { provider, secrets } = deadVault();
    await expect(provider.boot()).rejects.toThrow();
    await expect(secrets.encrypt(Buffer.from('probe', 'utf8'), 'hope-phi')).rejects.toThrow();
  });

  it('FLUSH: leaves the row byte-identical — no state, revision or _version movement', async () => {
    const { repo, store, updateWithVersion } = repositoryWithFakeDb({});
    const before = { ...store.row! };

    const result = await new DocumentSectionStore(repo, deadVault().secrets).applyFlushPatch(write());

    expect(result).toEqual({ applied: false, reason: 'unavailable' });
    expect(updateWithVersion).not.toHaveBeenCalled();
    expect(store.row).toEqual(before);
    // Spelled out, because these are the four columns the swallowed failure moved.
    expect(store.row!.state).toBe(DocumentSectionState.PROVISIONAL);
    expect(store.row!.revision).toBe(3);
    expect(store.row!.version).toBe(4);
    expect(store.row!.encryptedContent).toEqual(EXISTING_CIPHERTEXT);
  });

  it('FLUSH: publishes no patch, so no revision is claimed that the row does not carry', async () => {
    const { repo } = repositoryWithFakeDb({});

    const result = await new DocumentSectionStore(repo, deadVault().secrets).applyFlushPatch(write());

    // `publishSectionPatches` only publishes on `applied === true`; a refusal
    // carries no `patch` at all, so there is no `revision` to be wrong.
    expect(result.applied).toBe(false);
    expect(result).not.toHaveProperty('patch');
  });

  it('CLINICIAN: refuses instead of confirming a section whose text was never stored', async () => {
    const { repo, store, updateWithVersion } = repositoryWithFakeDb({});
    const before = { ...store.row! };

    const result = await new DocumentSectionStore(repo, deadVault().secrets).applyClinicianEdit(
      write({ content: 'Clinician: bacterial sinusitis.', userId: 'doctor-7', expectedVersion: 4 }),
    );

    expect(result).toEqual({ applied: false, reason: 'unavailable' });
    expect(updateWithVersion).not.toHaveBeenCalled();
    expect(store.row).toEqual(before);
    // The transition that would have lied: CONFIRMED over the previous ciphertext.
    expect(store.row!.state).not.toBe(DocumentSectionState.CONFIRMED);
    expect(store.row!.confirmedBy).toBeNull();
  });

  it('CREATE: writes no row at all rather than one whose body is permanently empty', async () => {
    // The create branch loses differently but just as completely: `encryptedContent`
    // is never assigned, so the row would be born with a NULL body it can never regain.
    const { repo, store, create } = repositoryWithFakeDb();

    const result = await new DocumentSectionStore(repo, deadVault().secrets).applyFlushPatch(write());

    expect(result).toEqual({ applied: false, reason: 'unavailable' });
    expect(create).not.toHaveBeenCalled();
    expect(store.row).toBeNull();
  });

  it('does not over-refuse: a WORKING encryptor still commits, with the new ciphertext', async () => {
    const { repo, store, updateWithVersion } = repositoryWithFakeDb({});

    const result = await new DocumentSectionStore(repo, workingTransit()).applyFlushPatch(write());

    expect(result.applied).toBe(true);
    expect(updateWithVersion).toHaveBeenCalledTimes(1);
    expect(store.row!.revision).toBe(4);
    expect(store.row!.version).toBe(5);
    expect(store.row!.encryptedContent).not.toEqual(EXISTING_CIPHERTEXT);
    // Proves the REAL encrypt path ran: `vault:v3:` is parsed into the key version.
    expect(store.row!.contentKeyVersion).toBe(3);
  });

  it('never puts section content in a log line on the failure path', async () => {
    const { repo } = repositoryWithFakeDb({});
    const secret = 'Likely bacterial sinusitis; start amoxicillin.';
    const store = new DocumentSectionStore(repo, deadVault().secrets);

    // Capture every level: the failure path must be loud for an operator and
    // silent about the body, and "loud" must not quietly become "verbose".
    const logged: unknown[] = [];
    const capture = (...args: unknown[]): never => {
      logged.push(...args);
      return undefined as never;
    };
    const logger = store['logger'] as unknown as Record<string, unknown>;
    for (const level of ['warn', 'log', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(logger as never, level).mockImplementation(capture as never);
    }

    await store.applyFlushPatch(write({ content: secret }));

    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain('amoxicillin');
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
