/**
 * TASK-1001 (wave 2) — a repeat ACROSS sections is FLAGGED, never dropped.
 *
 * ## The case these tests are built from
 *
 * A dev-cluster re-run on 2026-09-23 showed ONE turn writing the same two-sentence paragraph into
 * two DIFFERENT sections of one note, `family_history` and `diagnosis`. The per-section sentence
 * dedup cannot see that, by design — it compares a section only with itself. And it must not be
 * taught to drop it: the same clinical fact legitimately appears in two sections all the time (a
 * drug under treatment history AND under the plan of care), so deleting a cross-section repeat
 * could silently lose content, which OD-5 ranks worse than a duplicate.
 *
 * Owner decision (2026-09-23): FLAG IT, NEVER DROP IT. The later section's write carries a
 * `duplicate` annotation naming the section that already holds the text; the write itself is
 * byte-for-byte what it would have been without the rule.
 *
 * The measured pair was NOT an exact repeat: the `diagnosis` copy read `that symptoms such as`
 * where `family_history` read `that many of the symptoms such as`. So the flag matches
 * near-duplicates (Jaccard >= 0.8 over word tokens, number tokens identical as a multiset) — safe
 * here precisely because nothing is ever removed.
 *
 * The clinical text below is SYNTHETIC and reproduces only the SHAPE of what was observed.
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate } from '../../../../document-template/document-template-compiler';
import { applyTurn, CROSS_SECTION_DUPLICATE_JACCARD, CROSS_SECTION_DUPLICATE_MIN_RUN, wholeDocumentAsTurn } from '../turn-contract';

const compiled = compileDocumentTemplate({
  title: 'Clinical Note',
  sections: [
    { key: 'family_history', title: 'Family History', form: 'PROSE' },
    { key: 'diagnosis', title: 'Diagnosis', form: 'PROSE', required: true },
    { key: 'plan_of_care', title: 'Plan of Care', form: 'PROSE' },
  ],
} as never);

type SectionKey = 'family_history' | 'diagnosis' | 'plan_of_care';

/** A prior note in the template's authored order, so `applyTurn` aligns it by index. */
function noteWith(bodies: Partial<Record<SectionKey, string>> = {}) {
  return [
    { title: 'Family History', content: bodies.family_history ?? '' },
    { title: 'Diagnosis', content: bodies.diagnosis ?? '' },
    { title: 'Plan of Care', content: bodies.plan_of_care ?? '' },
  ];
}

/** The observed paragraph's two sentences, in synthetic form. */
const P1 = 'The patient mentioned that many of the symptoms such as cough, repeated fever and fatigue are caused by bacteria in the gut.';
const P2 = 'The patient also noted that rheumatoid arthritis and psoriasis conditions are related to gut issues.';
/** The observed near-duplicate: `many of the` dropped. Only P2 is an EXACT repeat. */
const P1_VARIANT = 'The patient mentioned that symptoms such as cough, repeated fever and fatigue are caused by bacteria in the gut.';

const PARAGRAPH = `${P1} ${P2}`;
const PARAGRAPH_VARIANT = `${P1_VARIANT} ${P2}`;

describe('TASK-1001 (wave 2) — the rule`s two numbers', () => {
  it('matches near-duplicates at Jaccard >= 0.8 and flags runs of at least two sentences', () => {
    expect(CROSS_SECTION_DUPLICATE_JACCARD).toBe(0.8);
    expect(CROSS_SECTION_DUPLICATE_MIN_RUN).toBe(2);
  });
});

describe('TASK-1001 (wave 2) — the observed case: one turn, one paragraph, two sections', () => {
  it('writes BOTH verbatim, and flags the LATER section (template order) with one annotation spanning exactly the paragraph', () => {
    const result = applyTurn(noteWith(), { family_history: { addition: PARAGRAPH }, diagnosis: { addition: PARAGRAPH } }, compiled);

    // Both writes happen, verbatim — the flag deletes nothing.
    expect(result.writes.map((write) => [write.sectionKey, write.mode, write.content])).toEqual([
      ['family_history', 'append', PARAGRAPH],
      ['diagnosis', 'append', PARAGRAPH],
    ]);
    expect(result.sections.map((section) => section.content)).toEqual([PARAGRAPH, PARAGRAPH, '']);

    // The EARLIER section carries nothing: the flag lands once, on the later copy.
    expect(result.writes[0]).not.toHaveProperty('duplicates');

    const [flag, ...others] = result.writes[1]!.duplicates ?? [];
    expect(others).toEqual([]);
    expect(flag).toEqual({
      kind: 'duplicate',
      start: 0,
      end: PARAGRAPH.length,
      duplicateOf: 'family_history',
      duplicateOfTitle: 'Family History',
    });
    expect(result.writes[1]!.content.slice(flag!.start, flag!.end)).toBe(PARAGRAPH);
    expect(result.crossSectionDuplicateCount).toBe(1);
    // Nothing was dropped and nothing refused — a flag is not a repetition refusal.
    expect(result.droppedSentenceCount).toBe(0);
    expect(result.refusals).toEqual([]);
  });

  it('the MEASURED pair — only the second sentence an exact repeat — is flagged too, with the title the client prefers', () => {
    expect(P1_VARIANT).not.toBe(P1);

    const result = applyTurn(noteWith(), { family_history: { addition: PARAGRAPH }, diagnosis: { addition: PARAGRAPH_VARIANT } }, compiled);

    expect(result.writes[1]!.content).toBe(PARAGRAPH_VARIANT);
    expect(result.writes[1]!.duplicates).toEqual([
      { kind: 'duplicate', start: 0, end: PARAGRAPH_VARIANT.length, duplicateOf: 'family_history', duplicateOfTitle: 'Family History' },
    ]);
    expect(result.crossSectionDuplicateCount).toBe(1);
  });

  it('content is BYTE-IDENTICAL with and without the rule firing', () => {
    // The rule fires when family_history carries the paragraph too; the control is the same
    // diagnosis write with nothing to be a duplicate OF.
    const prior = noteWith({ diagnosis: 'Suspected inflammatory arthritis.' });
    const flaggedTurn = applyTurn(prior, { family_history: { addition: PARAGRAPH }, diagnosis: { addition: PARAGRAPH } }, compiled);
    const control = applyTurn(prior, { diagnosis: { addition: PARAGRAPH } }, compiled);

    expect(flaggedTurn.crossSectionDuplicateCount).toBe(1);
    expect(control.crossSectionDuplicateCount).toBe(0);

    const { duplicates, ...flaggedWrite } = flaggedTurn.writes[1]!;
    expect(duplicates).toHaveLength(1);
    expect(flaggedWrite).toEqual(control.writes[0]);
    expect(control.writes[0]).not.toHaveProperty('duplicates');
    expect(flaggedTurn.sections[1]).toEqual(control.sections[1]);
    expect(flaggedTurn.sections[1]!.content).toBe(`Suspected inflammatory arthritis.\n\n${PARAGRAPH}`);
  });

  it('addresses the flag into the WRITE`s content — the new part — not the section body the append lands on', () => {
    const result = applyTurn(
      noteWith({ diagnosis: 'Suspected inflammatory arthritis.' }),
      { family_history: { addition: PARAGRAPH }, diagnosis: { addition: PARAGRAPH } },
      compiled,
    );

    const write = result.writes[1]!;
    expect(write.content).toBe(PARAGRAPH);
    // The store re-bases this onto the body; here it is 0-based in the new part.
    expect(write.duplicates![0]).toMatchObject({ start: 0, end: PARAGRAPH.length });
  });
});

describe('TASK-1001 (wave 2) — what the flag compares against', () => {
  it('flags a paragraph repeating another section`s STORED text from a previous turn', () => {
    const result = applyTurn(noteWith({ family_history: PARAGRAPH }), { diagnosis: { addition: PARAGRAPH } }, compiled);

    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.content).toBe(PARAGRAPH);
    expect(result.writes[0]!.duplicates).toEqual([
      { kind: 'duplicate', start: 0, end: PARAGRAPH.length, duplicateOf: 'family_history', duplicateOfTitle: 'Family History' },
    ]);
    expect(result.crossSectionDuplicateCount).toBe(1);
  });

  it('flags against stored text in a section LATER in template order, too', () => {
    const result = applyTurn(noteWith({ plan_of_care: PARAGRAPH }), { family_history: { addition: PARAGRAPH } }, compiled);

    expect(result.writes[0]!.duplicates).toEqual([
      { kind: 'duplicate', start: 0, end: PARAGRAPH.length, duplicateOf: 'plan_of_care', duplicateOfTitle: 'Plan of Care' },
    ]);
  });

  it('flags a first write that arrives as a `revision` on an EMPTY section — that is a first write, not a rewrite', () => {
    const result = applyTurn(noteWith({ family_history: PARAGRAPH }), { diagnosis: { revision: PARAGRAPH } }, compiled);

    expect(result.writes[0]).toMatchObject({ sectionKey: 'diagnosis', mode: 'replace', content: PARAGRAPH });
    expect(result.writes[0]!.duplicates).toHaveLength(1);
  });

  it('does not examine a CONTRADICTED revision of a section that had content — the rule covers appends and first writes', () => {
    const result = applyTurn(
      noteWith({ family_history: PARAGRAPH, diagnosis: 'Suspected inflammatory arthritis.' }),
      { diagnosis: { revision: PARAGRAPH, contradiction: 'The clinician withdrew the arthritis impression.' } },
      compiled,
    );

    expect(result.writes[0]).toMatchObject({ sectionKey: 'diagnosis', mode: 'replace', content: PARAGRAPH });
    expect(result.writes[0]).not.toHaveProperty('duplicates');
    expect(result.crossSectionDuplicateCount).toBe(0);
  });

  it('flags one annotation PER RUN, each naming its own section, and counts runs', () => {
    const planA = 'Start methotrexate at a weekly dose after the baseline liver tests.';
    const planB = 'Add folic acid on the days without methotrexate to limit side effects.';
    const unrelated = 'Hand joints were tender on examination today.';
    const content = `${P1} ${P2} ${unrelated} ${planA} ${planB}`;

    const prior = noteWith({ family_history: PARAGRAPH, plan_of_care: `${planA} ${planB}` });
    const result = applyTurn(prior, { diagnosis: { addition: content } }, compiled);

    const write = result.writes[0]!;
    expect(write.content).toBe(content);
    expect(write.duplicates).toEqual([
      { kind: 'duplicate', start: 0, end: PARAGRAPH.length, duplicateOf: 'family_history', duplicateOfTitle: 'Family History' },
      {
        kind: 'duplicate',
        start: content.indexOf(planA),
        end: content.length,
        duplicateOf: 'plan_of_care',
        duplicateOfTitle: 'Plan of Care',
      },
    ]);
    // The unrelated sentence between the two runs is not inside either span.
    for (const flag of write.duplicates!) expect(content.slice(flag.start, flag.end)).not.toContain(unrelated);
    expect(result.crossSectionDuplicateCount).toBe(2);
  });
});

describe('TASK-1001 (wave 2) — what is NOT flagged', () => {
  it('a SINGLE repeated sentence is not flagged', () => {
    const result = applyTurn(noteWith({ family_history: P1 }), { diagnosis: { addition: `${P1} Joint pain is worse in the mornings.` } }, compiled);

    expect(result.writes[0]!.content).toBe(`${P1} Joint pain is worse in the mornings.`);
    expect(result.writes[0]).not.toHaveProperty('duplicates');
    expect(result.crossSectionDuplicateCount).toBe(0);
  });

  it('two sections sharing only a VITAL SIGN are not flagged', () => {
    const soap = compileDocumentTemplate({
      title: 'SOAP',
      sections: [
        { key: 'objective', title: 'Objective', form: 'PROSE' },
        { key: 'assessment', title: 'Assessment', form: 'PROSE' },
      ],
    } as never);
    const vital = 'Blood pressure 150/95 mmHg.';

    const result = applyTurn(
      [
        { title: 'Objective', content: `${vital} Heart sounds are normal.` },
        { title: 'Assessment', content: '' },
      ],
      { assessment: { addition: `${vital} Consistent with stage two hypertension.` } },
      soap,
    );

    expect(result.writes[0]).not.toHaveProperty('duplicates');
    expect(result.crossSectionDuplicateCount).toBe(0);
  });

  it('two sections sharing only a DRUG LINE are not flagged — nor a drug list whose abbreviations split it', () => {
    const drug = 'Tab amlodipine 5 mg once daily.';
    const single = applyTurn(
      noteWith({ plan_of_care: `${drug} Review in two weeks.` }),
      { diagnosis: { addition: `${drug} Ankle swelling since starting it.` } },
      compiled,
    );
    expect(single.writes[0]).not.toHaveProperty('duplicates');

    // `Inj.` and `Tab.` are one-word "sentences" under the shared splitter. They are not eligible,
    // so they END a run: a drug list under treatment history AND the plan is the ordinary case.
    const list = 'Inj. ATG 5 mg IV daily. Tab. Prednisolone 10 mg at night.';
    const abbreviated = applyTurn(noteWith({ plan_of_care: list }), { family_history: { addition: list } }, compiled);
    expect(abbreviated.writes[0]!.content).toBe(list);
    expect(abbreviated.writes[0]).not.toHaveProperty('duplicates');
    expect(abbreviated.crossSectionDuplicateCount).toBe(0);
  });

  it('a CHANGED NUMBER breaks the match — however many words the sentences share', () => {
    const dose = (mg: string) => `Continue cyclophosphamide ${mg} mg intravenously once daily with hydration and mesna cover.`;
    const counts = 'Review blood counts every morning before the infusion.';

    // 11 of 13 tokens shared (0.85) — the words alone WOULD match. The dose is what keeps them apart.
    const changed = applyTurn(
      noteWith({ plan_of_care: `${dose('1000')} ${counts}` }),
      { diagnosis: { addition: `${dose('100')} ${counts}` } },
      compiled,
    );
    expect(changed.writes[0]).not.toHaveProperty('duplicates');
    expect(changed.crossSectionDuplicateCount).toBe(0);

    // Control: the same pair with the SAME dose and a reworded word is a near-duplicate, and is flagged.
    const same = applyTurn(
      noteWith({ plan_of_care: `${dose('1000')} ${counts}` }),
      { diagnosis: { addition: `${dose('1000').replace('intravenously', 'intravenous')} ${counts}` } },
      compiled,
    );
    expect(same.writes[0]!.duplicates).toHaveLength(1);

    // A decimal is ONE number token: `1.05` against `1.5` is a different value, not `1` + `05`.
    const tsh = (value: string) => `Serum TSH ${value} ng/mL on the last visit.`;
    const decimal = applyTurn(
      noteWith({ plan_of_care: `${tsh('1.05')} ${counts}` }),
      { diagnosis: { addition: `${tsh('1.5')} ${counts}` } },
      compiled,
    );
    expect(decimal.writes[0]).not.toHaveProperty('duplicates');
  });

  it('two unrelated sentences that merely share many words (below 0.8) are not flagged', () => {
    // 10/14 ≈ 0.71 and 9/12 = 0.75: close in wording, different in content.
    const stored =
      'The patient reports a dry cough with fever and chills at night. She has no known drug allergies and takes no regular medication.';
    const written =
      'The patient reports a wet cough with fever and chills at dawn. She has known drug allergies to penicillin and takes regular medication.';

    const result = applyTurn(noteWith({ family_history: stored }), { diagnosis: { addition: written } }, compiled);

    expect(result.writes[0]!.content).toBe(written);
    expect(result.writes[0]).not.toHaveProperty('duplicates');
    expect(result.crossSectionDuplicateCount).toBe(0);
  });

  it('a repeat WITHIN one section is still the per-section dedup`s business — dropped there, never flagged', () => {
    const result = applyTurn(noteWith({ family_history: PARAGRAPH, diagnosis: PARAGRAPH }), { diagnosis: { addition: PARAGRAPH } }, compiled);

    expect(result.writes).toEqual([]);
    expect(result.refusals).toEqual([{ sectionKey: 'diagnosis', reason: 'addition-already-present' }]);
    expect(result.crossSectionDuplicateCount).toBe(0);
  });

  it('the whole-document degrade flags nothing — it rewrites every section every flush', () => {
    const degraded = wholeDocumentAsTurn(
      [
        { title: 'Family History', content: PARAGRAPH },
        { title: 'Diagnosis', content: PARAGRAPH },
        { title: 'Plan of Care', content: '' },
      ],
      compiled,
    );

    expect(degraded.crossSectionDuplicateCount).toBe(0);
    for (const write of degraded.writes) expect(write).not.toHaveProperty('duplicates');
  });
});
