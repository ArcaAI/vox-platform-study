/**
 * TASK-1001 (wave 2, final note) — `finalNoteSections`: the FINAL note, split at its headings, with
 * the cross-section `duplicate` flags computed over its final text.
 *
 * ## Why
 *
 * The live note carries `{kind:'duplicate', start, end, duplicateOf, duplicateOfTitle}` when the
 * model filed one passage into two sections (owner decision 2026-09-23: FLAG, never drop). After
 * the consultation ends the client shows the FINAL note — the finalizer's narrative, split by its
 * headings (ALaaS `parseFinalizerNote` / `parseHeadedNote`) — and that note carried no annotations,
 * so the flag disappeared exactly when the clinician reviews the note.
 *
 * ## The contract pinned here
 *
 *  - a section is a heading line (`## Title`, `**Title**`, `**Title:**`) and the text up to the next
 *    one — the rule the client already splits this note with, so both sides see the same sections;
 *  - a section is LOCATED (`start`/`end` into the note), never copied — so the note stays the one
 *    unaltered copy of its text;
 *  - `annotations` are `duplicate` flags ONLY, section-LOCAL, on the LATER copy, by the live
 *    detector (`crossSectionDuplicateAnnotations`);
 *  - `sectionKey` is the consultation's own document key for that title when one exists, else a
 *    key derived from the heading.
 *
 * The clinical text is SYNTHETIC.
 */
import { describe, expect, it } from 'vitest';

import { finalNoteSections, sectionKeysByTitle, splitHeadedNote } from '../final-note-sections';

const P1 = 'The patient mentioned that many of the symptoms such as cough, repeated fever and fatigue are caused by bacteria in the gut.';
const P2 = 'The patient also noted that rheumatoid arthritis and psoriasis conditions are related to gut issues.';
const PARAGRAPH = `${P1} ${P2}`;

/** A finalizer note in the shape the harness persists: markdown headings, the paragraph filed twice. */
const NOTE = [
  '## Family History',
  'Mother has type 2 diabetes.',
  '',
  PARAGRAPH,
  '',
  '## Diagnosis',
  'Suspected inflammatory arthritis.',
  '',
  PARAGRAPH,
  '',
  '## Plan of Care',
  'Start Tab Methotrexate 7.5 mg weekly. Review in two weeks with a CBC and LFT.',
].join('\n');

const body = (content: string, section: { start: number; end: number }) => content.slice(section.start, section.end);

describe('splitHeadedNote — the note`s sections, located by offset', () => {
  it('finds each heading and locates its body, whitespace-trimmed, without copying it', () => {
    const spans = splitHeadedNote(NOTE);

    expect(spans.map((span) => span.title)).toEqual(['Family History', 'Diagnosis', 'Plan of Care']);
    expect(body(NOTE, spans[0]!)).toBe(`Mother has type 2 diabetes.\n\n${PARAGRAPH}`);
    expect(body(NOTE, spans[1]!)).toBe(`Suspected inflammatory arthritis.\n\n${PARAGRAPH}`);
    expect(body(NOTE, spans[2]!)).toBe('Start Tab Methotrexate 7.5 mg weekly. Review in two weeks with a CBC and LFT.');
  });

  it('reads the bold heading forms the finalizer also writes, and drops a trailing colon from the title', () => {
    const note = '**Chief Complaint:**\nJoint pain for three weeks.\n**History of Present Illness**\nMorning stiffness lasting an hour.';

    const spans = splitHeadedNote(note);

    expect(spans.map((span) => span.title)).toEqual(['Chief Complaint', 'History of Present Illness']);
    expect(body(note, spans[0]!)).toBe('Joint pain for three weeks.');
    expect(body(note, spans[1]!)).toBe('Morning stiffness lasting an hour.');
  });

  it('text before the first heading belongs to no section, and an empty section is an empty span', () => {
    const note = 'Clinical note, generated.\n\n## Allergies\n## Medications\nTab Paracetamol 500 mg SOS.';

    const spans = splitHeadedNote(note);

    expect(spans.map((span) => span.title)).toEqual(['Allergies', 'Medications']);
    expect(spans[0]!.start).toBe(spans[0]!.end);
    expect(body(note, spans[1]!)).toBe('Tab Paracetamol 500 mg SOS.');
  });

  it('a note with no headings has no sections', () => {
    expect(splitHeadedNote(PARAGRAPH)).toEqual([]);
  });
});

describe('finalNoteSections — the final note carries the cross-section flag', () => {
  it('flags the LATER copy of a two-section repeated paragraph, section-locally, naming the earlier section', () => {
    const sections = finalNoteSections(NOTE)!;

    expect(sections.map((section) => [section.sectionKey, section.title])).toEqual([
      ['family_history', 'Family History'],
      ['diagnosis', 'Diagnosis'],
      ['plan_of_care', 'Plan of Care'],
    ]);
    expect(sections[0]).not.toHaveProperty('annotations');
    expect(sections[2]).not.toHaveProperty('annotations');

    const diagnosis = sections[1]!;
    const text = body(NOTE, diagnosis);
    expect(diagnosis.annotations).toEqual([
      {
        kind: 'duplicate',
        start: text.indexOf(P1),
        end: text.indexOf(P1) + PARAGRAPH.length,
        duplicateOf: 'family_history',
        duplicateOfTitle: 'Family History',
      },
    ]);
    // Section-LOCAL: the offsets index the section's own text, not the whole note.
    const [flag] = diagnosis.annotations!;
    expect(text.slice(flag!.start, flag!.end)).toBe(PARAGRAPH);
  });

  it('carries NO content of its own — each body is only located in the note, which stays the one copy', () => {
    const sections = finalNoteSections(NOTE)!;

    for (const section of sections) {
      expect(Object.keys(section).sort()).toEqual(expect.arrayContaining(['end', 'sectionKey', 'start', 'title']));
      expect(section).not.toHaveProperty('content');
    }
  });

  it('flags nothing when the sections are unrelated — the sections are still reported', () => {
    const note = ['## Family History', 'Mother has type 2 diabetes.', '## Diagnosis', 'Suspected inflammatory arthritis.'].join('\n');

    const sections = finalNoteSections(note)!;

    expect(sections).toHaveLength(2);
    expect(sections.some((section) => 'annotations' in section)).toBe(false);
  });

  it('is absent for a note with fewer than two headed sections — there is nothing to compare across', () => {
    expect(finalNoteSections(PARAGRAPH)).toBeUndefined();
    expect(finalNoteSections(`## Diagnosis\n${PARAGRAPH}`)).toBeUndefined();
    expect(finalNoteSections('')).toBeUndefined();
  });

  it('uses the consultation`s OWN document keys for a matching title (case and punctuation aside) — else derives one', () => {
    const keys = sectionKeysByTitle([
      { sectionKey: 'fam_hx', title: 'FAMILY HISTORY' },
      { sectionKey: 'dx', title: 'Diagnosis:' },
    ]);

    const sections = finalNoteSections(NOTE, keys)!;

    expect(sections.map((section) => section.sectionKey)).toEqual(['fam_hx', 'dx', 'plan_of_care']);
    expect(sections[1]!.annotations!.map((flag) => [flag.duplicateOf, flag.duplicateOfTitle])).toEqual([['fam_hx', 'Family History']]);
  });

  it('the first row wins when two documents share a title', () => {
    const keys = sectionKeysByTitle([
      { sectionKey: 'dx_note', title: 'Diagnosis' },
      { sectionKey: 'dx_letter', title: 'Diagnosis' },
    ]);

    expect(finalNoteSections(NOTE, keys)![1]!.sectionKey).toBe('dx_note');
  });
});
