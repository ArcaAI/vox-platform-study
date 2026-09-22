/**
 * TASK-1001 OD-5 — the append guard is per SENTENCE.
 *
 * ## The defect these cases are built from
 *
 * One consultation's stored note was decrypted on 2026-09-22. `plan_of_care` held two genuine
 * content blocks and FIVE further copies of them; `diagnosis` held two blocks and then those two
 * concatenated verbatim. The guard that should have stopped it was `!before.includes(addition)` —
 * a case-, whitespace- and punctuation-sensitive containment test of the WHOLE trimmed addition —
 * and every observed shape walked straight through it:
 *
 * | Shape | Why the old guard missed it |
 * |---|---|
 * | `S1 + S2` restated as one addition, joined by a single SPACE | storage joins with `\n\n`, so it is not a contiguous substring |
 * | `S1' + S2`, where `S1'` differs from `S1` by ONE SPACE inside a drug name | byte comparison |
 * | `S2` with its doses respaced (`1000mg` → `1000 mg`) | byte comparison |
 * | `S2` then `S1`, reordered | containment is order-sensitive |
 *
 * **Every duplicate was an exact-sentence repeat modulo whitespace, punctuation or ordering. Not
 * one was a paraphrase.** So the fix is exact-normalised sentence dedup and deliberately nothing
 * more: similarity matching would drop text the clinician actually said, and OD-5 ranks a silently
 * missing sentence as the worse defect. The cases below are therefore in two halves — the shapes
 * that MUST stop being written, and the safety floor that must keep being written.
 *
 * The clinical text here is SYNTHETIC. It reproduces the STRUCTURE of the decrypted note (a
 * haematology plan: two blocks, a drug list with doses, lab values with decimals) and none of its
 * content; the ticket deliberately records structure only.
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate } from '../../../../document-template/document-template-compiler';
import { applyTurn, wholeDocumentAsTurn } from '../turn-contract';

const compiled = compileDocumentTemplate({
  title: 'Clinical Note',
  sections: [
    { key: 'diagnosis', title: 'Diagnosis', form: 'PROSE', required: true },
    { key: 'plan_of_care', title: 'Plan of Care', form: 'PROSE' },
    { key: 'investigations', title: 'Investigations', form: 'PROSE' },
  ],
} as never);

/** The two genuine blocks of the decrypted `plan_of_care`, in synthetic form. */
const S1 = 'Plan for allogeneic transplant with conditioning using fludarabine, atg and low dose cyclophosphamide.';
const S2 = 'Continue cyclophosphamide 1000mg IV daily and prednisolone 5mg at bedtime.';
/** Genuinely new content — the one thing a later turn actually had to say. */
const S3 = 'Repeat complete blood count and liver function tests after three days.';

/** B0 shape 4 — one space removed inside a drug name (`tg, atg` → `tg,atg` in the real note). */
const S1_TIGHT = S1.replace('fludarabine, atg', 'fludarabine,atg');
/** B0 shape 7 — the doses respaced. */
const S2_RESPACED = S2.replace('1000mg', '1000 mg').replace('5mg', '5 mg');

const DX = 'Severe aplastic anaemia with transfusion dependence.';

type SectionKey = 'diagnosis' | 'plan_of_care' | 'investigations';

/** A prior note in the template's authored order, so `applyTurn` aligns it by index. */
function noteWith(bodies: Partial<Record<SectionKey, string>>) {
  return [
    { title: 'Diagnosis', content: bodies.diagnosis ?? '' },
    { title: 'Plan of Care', content: bodies.plan_of_care ?? '' },
    { title: 'Investigations', content: bodies.investigations ?? '' },
  ];
}

const storedPlan = `${S1}\n\n${S2}`;

describe('TASK-1001 — the B0 shapes stop being written', () => {
  it('B0 shape 3/5 — a SUPERSET restatement joined by a single space is not written', () => {
    const result = applyTurn(noteWith({ plan_of_care: storedPlan }), { plan_of_care: { addition: `${S1} ${S2}` } }, compiled);

    // The whole point: this addition is NOT a substring of the stored text, because storage joins
    // with "\n\n" and the model rejoined with " ". The old guard wrote it; sentence dedup does not.
    expect(storedPlan.includes(`${S1} ${S2}`)).toBe(false);
    expect(result.writes).toEqual([]);
    expect(result.refusals).toEqual([{ sectionKey: 'plan_of_care', reason: 'addition-already-present' }]);
    expect(result.droppedSentenceCount).toBe(2);
    expect(result.sections[1]!.content).toBe(storedPlan);
  });

  it('B0 shape 4 — an addition differing only by a space inside a drug name is not written', () => {
    expect(S1_TIGHT).not.toBe(S1);

    const result = applyTurn(noteWith({ plan_of_care: storedPlan }), { plan_of_care: { addition: `${S1_TIGHT} ${S2}` } }, compiled);

    expect(result.writes).toEqual([]);
    expect(result.refusals).toEqual([{ sectionKey: 'plan_of_care', reason: 'addition-already-present' }]);
    expect(result.droppedSentenceCount).toBe(2);
    expect(result.sections[1]!.content).toBe(storedPlan);
  });

  it('B0 shape 7 — an addition whose doses are respaced (1000mg → 1000 mg, 5mg → 5 mg) is not written', () => {
    expect(S2_RESPACED).not.toBe(S2);
    expect(S2_RESPACED).toContain('1000 mg');
    expect(S2_RESPACED).toContain('5 mg');

    const result = applyTurn(noteWith({ plan_of_care: storedPlan }), { plan_of_care: { addition: S2_RESPACED } }, compiled);

    expect(result.writes).toEqual([]);
    expect(result.refusals).toEqual([{ sectionKey: 'plan_of_care', reason: 'addition-already-present' }]);
    expect(result.droppedSentenceCount).toBe(1);
    expect(result.sections[1]!.content).toBe(storedPlan);
  });

  it('B0 shape 6 — the same two blocks REORDERED are not written', () => {
    const result = applyTurn(noteWith({ plan_of_care: storedPlan }), { plan_of_care: { addition: `${S2} ${S1}` } }, compiled);

    expect(result.writes).toEqual([]);
    expect(result.refusals).toEqual([{ sectionKey: 'plan_of_care', reason: 'addition-already-present' }]);
    expect(result.droppedSentenceCount).toBe(2);
    expect(result.sections[1]!.content).toBe(storedPlan);
  });

  it('appends EXACTLY the one new sentence of a three-sentence addition whose other two are stored', () => {
    const result = applyTurn(noteWith({ plan_of_care: storedPlan }), { plan_of_care: { addition: `${S1} ${S2} ${S3}` } }, compiled);

    expect(result.writes).toEqual([{ sectionKey: 'plan_of_care', title: 'Plan of Care', idx: 1, mode: 'append', content: S3 }]);
    expect(result.refusals).toEqual([]);
    expect(result.droppedSentenceCount).toBe(2);
    expect(result.sections[1]!.content).toBe(`${storedPlan}\n\n${S3}`);
  });

  it('counts dropped sentences across EVERY section of the turn, not per section', () => {
    const prior = noteWith({ diagnosis: DX, plan_of_care: storedPlan });
    const turn = { diagnosis: { addition: DX }, plan_of_care: { addition: `${S2} ${S1}` } };

    const result = applyTurn(prior, turn, compiled);

    expect(result.writes).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.sectionKey)).toEqual(['diagnosis', 'plan_of_care']);
    expect(result.droppedSentenceCount).toBe(3);
  });
});

describe('TASK-1001 — the clinical safety floor: new content is always written', () => {
  it('a sentence differing in a NUMBER, DOSE, DATE or LATERALITY is NEW and is appended', () => {
    // Normalisation removes whitespace, never digits — so 1000mg and 100mg never normalise equal.
    const dose = applyTurn(
      noteWith({ plan_of_care: storedPlan }),
      { plan_of_care: { addition: S2.replace('1000mg', '100mg') } },
      compiled,
    );
    expect(dose.writes).toHaveLength(1);
    expect(dose.writes[0]!.content).toBe(S2.replace('1000mg', '100mg'));
    expect(dose.droppedSentenceCount).toBe(0);

    const laterality = applyTurn(
      noteWith({ diagnosis: 'Tenderness noted over the left iliac crest.' }),
      { diagnosis: { addition: 'Tenderness noted over the right iliac crest.' } },
      compiled,
    );
    expect(laterality.writes).toHaveLength(1);
    expect(laterality.writes[0]!.content).toBe('Tenderness noted over the right iliac crest.');

    const date = applyTurn(
      noteWith({ plan_of_care: 'Transplant scheduled for 11 May.' }),
      { plan_of_care: { addition: 'Transplant scheduled for 12 May.' } },
      compiled,
    );
    expect(date.writes).toHaveLength(1);
    expect(date.writes[0]!.content).toBe('Transplant scheduled for 12 May.');
  });

  it('THE SPLITTER DOES NOT SPLIT ON A PERIOD BETWEEN DIGITS — 1.05 ng/mL and 488.2 IU/mL stay whole', () => {
    const labs = 'Serum TSH 1.05 ng/mL and ferritin 488.2 IU/mL.';
    const laterLabs = 'Serum TSH 1.50 ng/mL and ferritin 488.9 IU/mL.';
    const prior = noteWith({ investigations: labs });

    // A splitter that broke on every "." would cut BOTH bodies into "Serum TSH 1.", "05 ng/mL and
    // ferritin 488." and "2 IU/mL." — then drop "Serum TSH 1." as already present and append a
    // headless "50 ng/mL and ferritin 488.9 IU/mL." to the note. That is data corruption wearing a
    // dedup's clothes, so it is pinned here rather than left to the implementation's good manners.
    const changed = applyTurn(prior, { investigations: { addition: laterLabs } }, compiled);
    expect(changed.writes).toHaveLength(1);
    expect(changed.writes[0]!.content).toBe(laterLabs);
    expect(changed.droppedSentenceCount).toBe(0);

    // ...and the SAME lab line is still recognised as one whole sentence already present.
    const repeated = applyTurn(prior, { investigations: { addition: labs } }, compiled);
    expect(repeated.writes).toEqual([]);
    expect(repeated.droppedSentenceCount).toBe(1);
  });

  it('appends the ORIGINAL text, never the normalised comparison form', () => {
    // Deliberately carries capitals and a DOUBLE space — both are erased by normalisation, so if
    // the comparison form were ever written this assertion is what catches it.
    const survivor = 'Discuss with Dr Menon  regarding HLA typing of the sibling donor.';

    const result = applyTurn(noteWith({ plan_of_care: storedPlan }), { plan_of_care: { addition: `${S1} ${survivor}` } }, compiled);

    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.content).toBe(survivor);
    expect(result.sections[1]!.content).toBe(`${storedPlan}\n\n${survivor}`);
    expect(result.sections[1]!.content).toContain('Dr Menon  regarding');
  });

  it('never drops a ONE-WORD sentence, so an abbreviation is not deleted from a new drug line', () => {
    // "Inj. ATG 5 mg IV over four hours." splits into "Inj." and the rest, and "Inj." is present in
    // any section that already names an injection. Dropping it would silently delete the ROUTE from
    // the next drug line — the content loss OD-5 ranks worse than a duplicated sentence.
    const addition = 'Inj. Vancomycin 1 g IV twice daily.';

    const result = applyTurn(
      noteWith({ plan_of_care: 'Inj. ATG 5 mg IV over four hours.' }),
      { plan_of_care: { addition } },
      compiled,
    );

    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.content).toBe(addition);
    expect(result.droppedSentenceCount).toBe(0);
  });
});

describe('TASK-1001 — regression pins', () => {
  it('leaves the revision/contradiction rules exactly as TASK-939 set them', () => {
    const prior = noteWith({ diagnosis: DX });

    // A revision WITH a contradiction still replaces, and still carries the reason to the store.
    const justified = applyTurn(
      prior,
      {
        diagnosis: {
          revision: 'Severe aplastic anaemia, now transfusion independent.',
          contradiction: 'Clinician restated that transfusions stopped.',
        },
      },
      compiled,
    );
    expect(justified.writes).toEqual([
      {
        sectionKey: 'diagnosis',
        title: 'Diagnosis',
        idx: 0,
        mode: 'replace',
        content: 'Severe aplastic anaemia, now transfusion independent.',
        contradiction: { reason: 'Clinician restated that transfusions stopped.' },
      },
    ]);
    expect(justified.refusals).toEqual([]);
    expect(justified.droppedSentenceCount).toBe(0);

    // A revision WITHOUT one is still refused under its own reason — the new
    // `addition-already-present` reason never displaces it — and the prior text still stands.
    const unjustified = applyTurn(prior, { diagnosis: { revision: 'Aplastic anaemia.' } }, compiled);
    expect(unjustified.writes).toEqual([]);
    expect(unjustified.refusals).toEqual([{ sectionKey: 'diagnosis', reason: 'revision-without-contradiction' }]);
    expect(unjustified.sections[0]!.content).toBe(DX);
    expect(unjustified.droppedSentenceCount).toBe(0);

    // A revision of an EMPTY section is still the first content, with no contradiction needed.
    const first = applyTurn(noteWith({}), { plan_of_care: { revision: S1 } }, compiled);
    expect(first.writes).toEqual([{ sectionKey: 'plan_of_care', title: 'Plan of Care', idx: 1, mode: 'replace', content: S1 }]);
    expect(first.droppedSentenceCount).toBe(0);
  });

  it('the whole-document DEGRADE path reports no dropped sentences — it replaces rather than accumulates', () => {
    const degraded = wholeDocumentAsTurn([{ title: 'Diagnosis', content: DX }], compiled);

    expect(degraded.droppedSentenceCount).toBe(0);
    expect(degraded.refusals).toEqual([]);
  });
});
