/**
 * the DocumentSection state machine
 *
 * The load-bearing assertion in this file is `machineMayOverwrite()`: it is the
 * predicate the flush path consults before replacing a section's content, and
 * the only thing standing between a clinician's edit and a model that has just
 * decided to say something else. The rest of the state machine exists to make
 * that predicate answerable.
 */
import { describe, it, expect } from 'vitest';
import { DocumentSectionFactory } from '../../../../factories';
import { DocumentSectionState } from '../../../../enums';
import { BusinessException } from '@arcaai/exceptions';

const base = () =>
  DocumentSectionFactory.CreateDocumentSection({
    tenantId: 'tenant-1',
    consultationId: 'consultation-1',
    documentKey: 'soap_note',
    sectionKey: 'assessment',
    title: 'Assessment',
    idx: 2,
  });

describe('DocumentSectionFactory', () => {
  it('mints a UUIDv7 id, starts EMPTY at revision 0, and holds no ciphertext yet', () => {
    const section = base();

    expect(section.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(section.state).toBe(DocumentSectionState.EMPTY);
    expect(section.revision).toBe(0);
    expect(section.encryptedContent).toBeNull();
    expect(section.contentKeyVersion).toBeNull();
    expect(section.confirmedAt).toBeNull();
    expect(section.lockedAt).toBeNull();
  });
});

describe('DocumentSectionEntity — the section state machine', () => {
  it('EMPTY is a normal resting state, not an error: the machine may write it', () => {
    expect(base().machineMayOverwrite()).toBe(true);
  });

  it('a machine write promotes EMPTY -> PROVISIONAL and advances the revision', () => {
    const section = base();
    section.applyMachineContent('Likely viral URI.');

    expect(section.state).toBe(DocumentSectionState.PROVISIONAL);
    expect(section.revision).toBe(1);
    expect(section.content).toBe('Likely viral URI.');
    expect(section.machineMayOverwrite()).toBe(true);
  });

  it('a clinician write moves it to CONFIRMED and stamps who/when', () => {
    const section = base();
    section.applyMachineContent('Likely viral URI.');
    section.applyClinicianContent('Likely bacterial sinusitis.', 'doctor-7', new Date('2026-08-28T00:00:00.000Z'));

    expect(section.state).toBe(DocumentSectionState.CONFIRMED);
    expect(section.confirmedBy).toBe('doctor-7');
    expect(section.confirmedAt?.toISOString()).toBe('2026-08-28T00:00:00.000Z');
    expect(section.revision).toBe(2);
  });

  it('THE INVARIANT: a CONFIRMED section may never be overwritten by a flush', () => {
    const section = base();
    section.applyClinicianContent('Clinician text.', 'doctor-7');

    expect(section.machineMayOverwrite()).toBe(false);
    // …but it is still writable, because a flush may APPEND to it.
    expect(section.isWritable()).toBe(true);
  });

  it('a machine write never demotes CONFIRMED back to PROVISIONAL', () => {
    const section = base();
    section.applyClinicianContent('Clinician text.', 'doctor-7');
    section.applyMachineContent('Clinician text. Appended by a later flush.');

    expect(section.state).toBe(DocumentSectionState.CONFIRMED);
  });

  it('LOCKED rejects every writer, machine and clinician alike', () => {
    const section = base();
    section.applyMachineContent('Draft.');
    section.lock(new Date('2026-08-28T01:00:00.000Z'));

    expect(section.state).toBe(DocumentSectionState.LOCKED);
    expect(section.isWritable()).toBe(false);
    expect(section.machineMayOverwrite()).toBe(false);
    expect(section.lockedAt?.toISOString()).toBe('2026-08-28T01:00:00.000Z');
  });
});

describe('DocumentSectionEntity — change tracking + validation', () => {
  it('routes writes through setProperty so the repository persists only what changed', () => {
    const section = base();
    section.applyMachineContent('Draft.');

    // `changes` is what `Repository.update` writes; `content` is the transient
    // plaintext that `encryptContentIntoEntity` turns into ciphertext.
    expect(Object.keys(section.changes)).toEqual(expect.arrayContaining(['content', 'revision', 'state']));
  });

  it('refuses a section with no document identity', () => {
    const section = base();
    section.documentKey = '   ';
    expect(() => section.validate()).toThrow(BusinessException);
  });

  it('refuses a negative ordinal', () => {
    const section = base();
    section.idx = -1;
    expect(() => section.validate()).toThrow(BusinessException);
  });
});
