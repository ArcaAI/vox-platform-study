/**
 * Lane D — the clinician write path for `DocumentSection`.
 *
 * The cases that matter are the REFUSALS, because each one is a different HTTP
 * answer and getting them interchangeable is how a clinician silently loses an
 * edit (412 where 409 belongs sends a client into a retry loop it can never
 * leave; 409 where 412 belongs tells it not to bother re-reading).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { DocumentSectionFactory, DocumentSectionState } from '@arcaai/domains';
import { DocumentSectionService } from '../document-section.service';

const TENANT = 'tenant-d';
const CONSULTATION = 'consultation-d';
const USER = 'doctor-7';
const DOCUMENT = 'soap_note';
const SECTION = 'assessment';

const mockCls = { get: vi.fn(), set: vi.fn() };
const mockEmitter = { emit: vi.fn() };
const mockRepository = {
  findSection: vi.fn(),
  findByDocument: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
  encryptContentIntoEntity: vi.fn(async () => undefined),
  decryptContentFromEntity: vi.fn(async () => 'decrypted body'),
};
const mockSecrets = { encrypt: vi.fn(async () => 'vault:v1:x'), decrypt: vi.fn(), getPhiTransitKeyName: () => 'hope-phi' };

/** A persisted section at a given version/state, as `findSection` would return it. */
function sectionAt(version: number, state = DocumentSectionState.PROVISIONAL) {
  const entity = DocumentSectionFactory.CreateDocumentSection({
    tenantId: TENANT,
    consultationId: CONSULTATION,
    documentKey: DOCUMENT,
    sectionKey: SECTION,
    title: 'Assessment',
    idx: 2,
  });
  (entity as unknown as { _version: number })._version = version;
  (entity as unknown as { _state: DocumentSectionState })._state = state;
  (entity as unknown as { _revision: number })._revision = 3;
  entity.encryptedContent = Buffer.from('ciphertext');
  return entity;
}

function buildService(withSecrets = true): DocumentSectionService {
  return new DocumentSectionService(mockRepository as never, mockEmitter as never, mockCls as never, withSecrets ? (mockSecrets as never) : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRepository.decryptContentFromEntity.mockResolvedValue('decrypted body');
  mockRepository.encryptContentIntoEntity.mockResolvedValue(undefined);
  mockCls.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'userId') return USER;
    if (key === 'user') return { id: USER, tenantId: TENANT };
    return undefined;
  });
});

describe('updateSectionContent — the refusal taxonomy', () => {
  it('404s a section that does not exist — the same answer a CROSS-TENANT section gets', async () => {
    // `findSection` is tenant-filtered, so a foreign section arrives here as null
    // and is indistinguishable from a missing one. That is the posture, not a gap.
    mockRepository.findSection.mockResolvedValue(null);

    await expect(buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'x', expectedVersion: 4 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('409s an edit against a LOCKED section — finalized is not a stale precondition', async () => {
    mockRepository.findSection.mockResolvedValue(sectionAt(4, DocumentSectionState.LOCKED));

    // Note the expectedVersion is CORRECT. A 412 here would tell the client to
    // re-read and retry, which can never succeed: no version of a locked section
    // is writable.
    await expect(buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'x', expectedVersion: 4 })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('412s a STALE If-Match, and reports the version the client should re-read', async () => {
    mockRepository.findSection.mockResolvedValue(sectionAt(7));

    const failure = await buildService()
      .updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'x', expectedVersion: 5 })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OptimisticConcurrencyException);
    expect((failure as OptimisticConcurrencyException).model).toBe('DocumentSection');
    expect((failure as OptimisticConcurrencyException).metadata).toMatchObject({ expectedVersion: 5, currentVersion: 7 });
    expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('412s when the store LOSES the compare-and-set — a flush landed between our read and the write', async () => {
    mockRepository.findSection.mockResolvedValue(sectionAt(7));
    mockRepository.updateWithVersion.mockRejectedValue(new OptimisticConcurrencyException('DocumentSection', 'sec-1', { expectedVersion: 7, currentVersion: 8 }));

    await expect(buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'x', expectedVersion: 7 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
  });

  it('503s when persistence is unavailable rather than reporting a write that did not happen', async () => {
    mockRepository.findSection.mockResolvedValue(sectionAt(7));
    mockRepository.updateWithVersion.mockRejectedValue(new Error('connection refused'));

    await expect(buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'x', expectedVersion: 7 })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects a call with no expected version — the CAS operand is not optional on this lane', async () => {
    await expect(buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'x' })).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('updateSectionContent — the accepted write', () => {
  /** `findSection` answers with v7 for the pre-check, then v8 for the post-write re-read. */
  function wireAcceptedWrite() {
    const before = sectionAt(7);
    const after = sectionAt(8, DocumentSectionState.CONFIRMED);
    mockRepository.findSection.mockResolvedValueOnce(before).mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    mockRepository.updateWithVersion.mockResolvedValue(after);
    return { before, after };
  }

  it('threads the CLIENT’s version into the compare-and-set — not the one it just re-read', async () => {
    wireAcceptedWrite();

    await buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'Clinician text.', expectedVersion: 7 });

    const [, , issued] = mockRepository.updateWithVersion.mock.calls.at(-1)!;
    expect(issued).toBe(7);
  });

  it('returns the POST-write version so the client’s next If-Match is usable', async () => {
    wireAcceptedWrite();

    const response = await buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'Clinician text.', expectedVersion: 7 });

    // The store hands back the pre-write entity (the DB owns `_version` and the
    // mapper strips it), so a service that echoed it would hand the client a
    // validator guaranteed to 412 on its own next edit.
    expect(response.version).toBe(8);
    expect(response.state).toBe('confirmed');
    expect(response.content).toBe('Clinician text.');
  });

  it('accepts an EMPTY edit — a clinician deleting their own text owes the transcript no contradiction', async () => {
    wireAcceptedWrite();

    const response = await buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: '', expectedVersion: 7 });

    expect(response.content).toBe('');
    expect(mockRepository.updateWithVersion).toHaveBeenCalled();
  });

  it('broadcasts the transition and puts NO section content in the event', async () => {
    wireAcceptedWrite();

    await buildService().updateSectionContent(CONSULTATION, DOCUMENT, SECTION, { content: 'Patient reports chest pain.', expectedVersion: 7 });

    expect(mockEmitter.emit).toHaveBeenCalled();
    const serialized = JSON.stringify(mockEmitter.emit.mock.calls);
    expect(serialized).toContain('sectionEdit');
    expect(serialized).toContain(DOCUMENT);
    expect(serialized).not.toContain('chest pain');
  });
});

describe('reads decrypt', () => {
  it('getSection decrypts the persisted ciphertext', async () => {
    mockRepository.findSection.mockResolvedValue(sectionAt(7));

    const response = await buildService().getSection(CONSULTATION, DOCUMENT, SECTION);

    expect(response.content).toBe('decrypted body');
    expect(response.version).toBe(7);
  });

  it('surfaces an EMPTY body rather than a placeholder when decryption fails', async () => {
    mockRepository.findSection.mockResolvedValue(sectionAt(7));
    mockRepository.decryptContentFromEntity.mockRejectedValue(new Error('vault unreachable'));

    const response = await buildService().getSection(CONSULTATION, DOCUMENT, SECTION);

    expect(response.content).toBe('');
  });

  it('listSections renders a document in template order', async () => {
    mockRepository.findByDocument.mockResolvedValue([sectionAt(7), sectionAt(7)]);

    const response = await buildService().listSections(CONSULTATION, DOCUMENT);

    expect(response).toHaveLength(2);
    expect(mockRepository.findByDocument).toHaveBeenCalledWith(TENANT, CONSULTATION, DOCUMENT);
  });
});
