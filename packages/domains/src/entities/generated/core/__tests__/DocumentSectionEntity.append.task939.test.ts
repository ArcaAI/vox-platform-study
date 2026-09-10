/**
 * TASK-939 §2.3 — `appendMachineContent`, the half of the section state machine that was
 * specified in three places and implemented in none.
 *
 * The entity's own doc comment said *"A CONFIRMED section has been touched by a clinician, so a
 * flush may APPEND to it but must never overwrite it"*, `applyMachineContent`'s said *"the
 * clinician's touch … survives the append"*, and the shipped OpenAPI description said *"a flush
 * may append but will never overwrite it"*. There was no append method: the word occurred exactly
 * once in the whole write path, in a comment. This file is the behaviour those three sentences
 * described.
 *
 * The distinction that matters: `applyMachineContent` REPLACES and is therefore refused on a
 * CONFIRMED section; `appendMachineContent` ADDS and is not, because adding cannot destroy what
 * the clinician wrote.
 */
import { describe, expect, it } from 'vitest';

import { DocumentSectionFactory } from '../../../../factories';
import { DocumentSectionState } from '../../../../enums';

const make = () =>
  DocumentSectionFactory.CreateDocumentSection({
    tenantId: 'tenant-939',
    consultationId: 'consultation-939',
    documentKey: 'soap_note',
    sectionKey: 'subjective',
    title: 'Subjective',
    idx: 0,
    documentTemplateVersionId: null,
    createdBy: null,
  });

describe('TASK-939 — DocumentSectionEntity.appendMachineContent', () => {
  it('on an EMPTY section the first append simply becomes the content, with no leading separator', () => {
    const section = make();
    section.appendMachineContent('Patient reports a cough for three days.');

    expect(section.content).toBe('Patient reports a cough for three days.');
    expect(section.state).toBe(DocumentSectionState.PROVISIONAL);
    expect(section.revision).toBe(1);
  });

  it('preserves the prior text BYTE-FOR-BYTE and adds the new part after it', () => {
    const section = make();
    section.appendMachineContent('Cough for three days.');
    const before = section.content!;

    section.appendMachineContent('Now reports fever since last night.');

    // The invariant the whole ticket exists for: what the clinician already read is a PREFIX
    // of what they read next.
    expect(section.content!.startsWith(before)).toBe(true);
    expect(section.content).toBe('Cough for three days.\n\nNow reports fever since last night.');
    expect(section.revision).toBe(2);
  });

  it('appends to a CONFIRMED section WITHOUT demoting it — the clinician stays the higher authority', () => {
    const section = make();
    section.applyClinicianContent('Cough for three days. Clinician-reviewed.', 'doctor-1');
    const confirmedText = section.content!;
    const confirmedAt = section.confirmedAt;

    section.appendMachineContent('Now reports fever since last night.');

    expect(section.state).toBe(DocumentSectionState.CONFIRMED);
    expect(section.confirmedBy).toBe('doctor-1');
    expect(section.confirmedAt).toBe(confirmedAt);
    expect(section.content!.startsWith(confirmedText)).toBe(true);
  });

  it('is a no-op for an empty or whitespace-only addition — an untouched section stays untouched', () => {
    const section = make();

    section.appendMachineContent('');
    section.appendMachineContent('   \n  ');

    expect(section.revision).toBe(0);
    expect(section.state).toBe(DocumentSectionState.EMPTY);
    // A no-op must leave NOTHING for the repository to persist — `repository.update` writes
    // `entity.changes`, so tracking `content` here would write a row on every quiet turn.
    expect(section.changes).not.toHaveProperty('content');
    expect(section.changes).not.toHaveProperty('revision');
  });

  it('a no-op addition on a POPULATED section neither bumps the revision nor alters the text', () => {
    const section = make();
    section.appendMachineContent('Cough for three days.');

    section.appendMachineContent('   ');

    expect(section.revision).toBe(1);
    expect(section.content).toBe('Cough for three days.');
  });

  it('carries annotations and provenance through, like a machine replace does', () => {
    const section = make();
    section.appendMachineContent('Cough for three days.', [{ kind: 'entity', start: 0, end: 5 }] as never, [
      { transcriptSegmentId: 'seg-1' },
    ] as never);

    expect(section.annotations).toEqual([{ kind: 'entity', start: 0, end: 5 }]);
    expect(section.provenance).toEqual([{ transcriptSegmentId: 'seg-1' }]);
  });

  it('a REPLACE is still a replace — appendMachineContent must not be mistaken for one', () => {
    const section = make();
    section.appendMachineContent('Cough for three days.');
    section.applyMachineContent('Entirely different text.');

    expect(section.content).toBe('Entirely different text.');
  });
});
