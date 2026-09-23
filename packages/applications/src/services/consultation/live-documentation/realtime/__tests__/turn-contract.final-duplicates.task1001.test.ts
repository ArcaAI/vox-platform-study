/**
 * TASK-1001 (wave 2, final note) — `crossSectionDuplicateAnnotations`: the SAME cross-section
 * detector a live turn runs (`applyTurn` → `crossSectionDuplicates`), exported for text that will
 * not change again — a FINISHED document.
 *
 * Why it exists: the live note carries a `duplicate` annotation when the model filed one passage
 * into two sections, but the note a client shows once the consultation is finalised carried none —
 * so the flag vanished exactly when the clinician reviews the note. The final flags are computed
 * over the FINAL text with this function, never with a second copy of the rule.
 *
 * The contract pinned here:
 *  - flag, never drop: the function READS content and returns annotations; nothing else;
 *  - offsets are section-LOCAL — they index the flagged section's own `content`;
 *  - in a finished document the LATER copy (in the order given) is flagged, pointing at the
 *    earlier one, and never both — the same outcome `applyTurn` gives one turn writing a
 *    paragraph into two sections;
 *  - the match rule is the live one: normalised-equal, or Jaccard >= 0.8 with identical number
 *    tokens, over a run of >= 2 consecutive eligible sentences.
 *
 * The clinical text is SYNTHETIC (the shape of the 2026-09-23 cluster case, as in
 * `turn-contract.cross-section.task1001.test.ts`).
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate } from '../../../../document-template/document-template-compiler';
import { applyTurn, crossSectionDuplicateAnnotations, type DocumentSectionText } from '../turn-contract';

const P1 = 'The patient mentioned that many of the symptoms such as cough, repeated fever and fatigue are caused by bacteria in the gut.';
const P2 = 'The patient also noted that rheumatoid arthritis and psoriasis conditions are related to gut issues.';
/** The observed near-duplicate: `many of the` dropped. Only P2 is an EXACT repeat. */
const P1_VARIANT = 'The patient mentioned that symptoms such as cough, repeated fever and fatigue are caused by bacteria in the gut.';
const PARAGRAPH = `${P1} ${P2}`;

const FAMILY = 'Mother has type 2 diabetes. Father had a myocardial infarction at 60.';
/** Long enough that a one-number change still scores Jaccard >= 0.8 (15/17) — so only the NUMBER rule keeps it apart. */
const DOSE = 'Start Tab Methotrexate 7.5 mg orally once weekly on Sunday mornings after breakfast with folic acid.';
const PLAN = `${DOSE} Review in two weeks with a CBC and LFT.`;

const section = (sectionKey: string, title: string, content: string): DocumentSectionText => ({ sectionKey, title, content });

describe('crossSectionDuplicateAnnotations — a paragraph repeated across two sections of a finished note', () => {
  it('flags the LATER section once, section-locally, pointing at the earlier one — and leaves the earlier one clean', () => {
    const familyHistory = `${FAMILY}\n\n${PARAGRAPH}`;
    const diagnosis = `Suspected inflammatory arthritis.\n\n${PARAGRAPH}`;
    const sections = [section('family_history', 'Family History', familyHistory), section('diagnosis', 'Diagnosis', diagnosis)];

    const [onFamily, onDiagnosis] = crossSectionDuplicateAnnotations(sections);

    expect(onFamily).toEqual([]);
    expect(onDiagnosis).toEqual([
      {
        kind: 'duplicate',
        start: diagnosis.indexOf(P1),
        end: diagnosis.indexOf(P1) + PARAGRAPH.length,
        duplicateOf: 'family_history',
        duplicateOfTitle: 'Family History',
      },
    ]);
    // Section-LOCAL: the offsets index the flagged section's own text, and address exactly the run.
    expect(diagnosis.slice(onDiagnosis![0]!.start, onDiagnosis![0]!.end)).toBe(PARAGRAPH);
  });

  it('never alters the text it reads — every input is byte-identical afterwards', () => {
    const sections = [section('family_history', 'Family History', PARAGRAPH), section('diagnosis', 'Diagnosis', PARAGRAPH)];
    const before = JSON.stringify(sections);

    crossSectionDuplicateAnnotations(sections);

    expect(JSON.stringify(sections)).toBe(before);
  });

  it('matches the measured NEAR-duplicate (only the second sentence exact) — the live rule, not an exact-only one', () => {
    const variant = `${P1_VARIANT} ${P2}`;
    const [, onDiagnosis] = crossSectionDuplicateAnnotations([
      section('family_history', 'Family History', PARAGRAPH),
      section('diagnosis', 'Diagnosis', variant),
    ]);

    expect(onDiagnosis).toEqual([
      { kind: 'duplicate', start: 0, end: variant.length, duplicateOf: 'family_history', duplicateOfTitle: 'Family History' },
    ]);
  });

  it('flags nothing when the sections are unrelated', () => {
    expect(
      crossSectionDuplicateAnnotations([
        section('family_history', 'Family History', FAMILY),
        section('diagnosis', 'Diagnosis', 'Suspected inflammatory arthritis. Differential includes reactive arthritis.'),
        section('plan_of_care', 'Plan of Care', PLAN),
      ]),
    ).toEqual([[], [], []]);
  });

  it('a single shared sentence is ordinary (the same drug line in two sections) and is not flagged', () => {
    expect(
      crossSectionDuplicateAnnotations([
        section('treatment_history', 'Treatment History', `Tab Methotrexate 7.5 mg weekly since March. ${FAMILY}`),
        section('plan_of_care', 'Plan of Care', 'Tab Methotrexate 7.5 mg weekly since March. Review in two weeks with a CBC and LFT.'),
      ]),
    ).toEqual([[], []]);
  });

  it('a changed NUMBER is different clinical content, never a repeat — even inside an otherwise repeated run', () => {
    // Without the number rule the dose sentence would match (15/17 tokens shared) and, with the exact
    // second sentence, form a flaggable run of two. With it the run is one sentence long.
    const doseChanged = PLAN.replace('7.5 mg', '10 mg');
    expect(crossSectionDuplicateAnnotations([section('plan_of_care', 'Plan of Care', PLAN), section('follow_up', 'Follow-up', doseChanged)])).toEqual(
      [[], []],
    );
  });

  it('two entries under the SAME sectionKey are one section, and are never compared with each other', () => {
    expect(crossSectionDuplicateAnnotations([section('plan_of_care', 'Plan', PARAGRAPH), section('plan_of_care', 'Plan', PARAGRAPH)])).toEqual([
      [],
      [],
    ]);
  });

  it('a third copy points at the EARLIEST section (ties go to the section first in order)', () => {
    const [first, second, third] = crossSectionDuplicateAnnotations([
      section('family_history', 'Family History', PARAGRAPH),
      section('diagnosis', 'Diagnosis', PARAGRAPH),
      section('plan_of_care', 'Plan of Care', PARAGRAPH),
    ]);

    expect(first).toEqual([]);
    expect(second!.map((flag) => flag.duplicateOf)).toEqual(['family_history']);
    expect(third!.map((flag) => flag.duplicateOf)).toEqual(['family_history']);
  });

  it('is the SAME detector a live turn runs: one turn writing the paragraph into two sections yields the identical annotation', () => {
    const compiled = compileDocumentTemplate({
      title: 'Clinical Note',
      sections: [
        { key: 'family_history', title: 'Family History', form: 'PROSE' },
        { key: 'diagnosis', title: 'Diagnosis', form: 'PROSE', required: true },
      ],
    } as never);
    const prior = [
      { title: 'Family History', content: '' },
      { title: 'Diagnosis', content: '' },
    ];

    const live = applyTurn(prior, { family_history: { addition: PARAGRAPH }, diagnosis: { addition: PARAGRAPH } }, compiled);
    const final = crossSectionDuplicateAnnotations(live.sections.map((s, i) => section(compiled.sectionKeys[i]!, s.title, s.content)));

    expect(final[1]).toEqual(live.writes[1]!.duplicates);
    expect(final[0]).toEqual([]);
  });
});
