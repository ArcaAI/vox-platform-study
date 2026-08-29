/**
 * TASK-820 — the mapper must be able to CLEAR `encryptedContent`.
 *
 * `DocumentSection.content` is transient: `encryptedContent` is the only
 * persisted form of the body, so "the clinician emptied this section" can only
 * be expressed as an explicit `encryptedContent: null` in the update payload.
 * `DocumentSectionRepository.encryptContentIntoEntity` writes that null; this
 * file pins the fact that the mapper actually CARRIES it to Prisma.
 *
 * That is not obvious from reading `AutoEntityChangeMapper`: its custom-mapping
 * pass ends in `if (result) model[key] = result`, which drops a null. The null
 * survives only because the GENERIC pass above it already copied the change —
 * so the two passes have to keep agreeing. If a later change makes the generic
 * pass skip nullish values, the clearing write silently reverts to a no-op and
 * TASK-820 returns under a green applications suite. Hence a test here, at the
 * layer where the property actually lives.
 */
import { describe, expect, it } from 'vitest';
import { DocumentSectionEntity } from '../../entities';
import { DocumentSectionState } from '../../enums';
import { DocumentSectionEntityMapper } from '../generated/core/DocumentSectionEntityMapper';

const EXISTING_CIPHERTEXT = Buffer.from('vault:v1:previously-stored-body', 'utf8');

/** A section as `findSection` reconstitutes it: from COLUMNS, so no `content`. */
function persistedSection(): DocumentSectionEntity {
  return new DocumentSectionEntity({
    id: 'section-820',
    version: 4,
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
    updatedAt: new Date('2026-08-30T00:00:00.000Z'),
    createdBy: null,
    updatedBy: null,
    tenantId: 'tenant-820',
    consultationId: 'consultation-820',
    documentKey: 'soap_note',
    sectionKey: 'assessment',
    title: 'Assessment',
    idx: 2,
    state: DocumentSectionState.PROVISIONAL,
    revision: 3,
    content: null,
    encryptedContent: EXISTING_CIPHERTEXT,
    contentKeyVersion: 1,
    annotations: null,
    provenance: null,
    documentTemplateVersionId: null,
    confirmedAt: null,
    confirmedBy: null,
    lockedAt: null,
    Consultation: null,
  });
}

describe('DocumentSectionEntityMapper — clearing the encrypted body', () => {
  it('carries an explicitly nulled encryptedContent into the update payload', () => {
    const section = persistedSection();
    section.applyClinicianContent('', 'doctor-7');
    section.encryptedContent = null;
    section.contentKeyVersion = null;

    const payload = DocumentSectionEntityMapper.getInstance().toPersistenceChanges(section) as Record<string, unknown>;

    // Presence AND value: an absent key leaves the column untouched, which is
    // exactly the silent loss this ticket exists to close.
    expect(Object.keys(payload)).toContain('encryptedContent');
    expect(payload.encryptedContent).toBeNull();
    expect(payload.contentKeyVersion).toBeNull();
  });

  it('omits encryptedContent entirely when the write never touched it', () => {
    // The counterpart: a metadata-only update must not blank the body.
    const section = persistedSection();
    section.title = 'Assessment & Plan';

    const payload = DocumentSectionEntityMapper.getInstance().toPersistenceChanges(section) as Record<string, unknown>;

    expect(Object.keys(payload)).toContain('title');
    expect(Object.keys(payload)).not.toContain('encryptedContent');
  });

  it('never emits the transient plaintext — there is no column for it', () => {
    const section = persistedSection();
    section.applyClinicianContent('Patient reports chest pain.', 'doctor-7');

    const payload = DocumentSectionEntityMapper.getInstance().toPersistenceChanges(section) as Record<string, unknown>;

    expect(Object.keys(payload)).not.toContain('content');
    expect(JSON.stringify(payload)).not.toContain('chest pain');
  });
});
