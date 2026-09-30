/**
 * TASK-1022 (wave 2, D-GROUND) — the per-turn reference blocks were COPIED into today's sections.
 *
 * Replay1020 run3, afternoon revisit, turn 1 (gemma-4-e2b). The transcript so far was only
 * "Good afternoon. Your reports are back.", yet the model filled today's sections from the
 * `SAME-DAY EARLIER VISIT(S)` block `buildTextUserPrompt` appends: the morning's examination went to
 * `examination_and_vitals`, the carried-over angina to `current_diagnosis`, the morning's aspirin plan
 * to `treatment_plan`. The TASK-1022 "REFERENCE ONLY" prompt line did not stop it.
 *
 * The guard pinned here is DETERMINISTIC and conservative: in a CURRENT-visit section, a sentence the
 * reference supports and the transcript does not is dropped; a PRIOR section is never touched; any
 * sentence sharing a number or a distinctive word with the transcript is kept. All strings below are
 * the replay's own (synthetic patient; no PHI).
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate } from '../../../../document-template/document-template-compiler';
import { applyTurn, type ParsedTurn, type TurnGrounding } from '../turn-contract';

const REVISIT_SECTIONS = [
  ['new_complaints', 'New Complaints'],
  ['last_visit_complaints', 'Last Visit Complaints'],
  ['previous_diagnosis', 'Previous Diagnosis'],
  ['current_medications', 'Current Medications'],
  ['investigations', 'Investigations (Previous vs Current)'],
  ['examination_and_vitals', 'General Examination & Vitals'],
  ['current_diagnosis', 'Current Diagnosis'],
  ['treatment_plan', 'Treatment Plan'],
  ['follow_up_plan', 'Follow-up Plan'],
  ['additional_data', 'Additional Data'],
  ['instructions_and_orders', 'Doctor’s Instructions & Orders'],
] as const;

const revisit = compileDocumentTemplate({
  title: 'General Medicine Consultation Note — Follow-up / Review Visit',
  sections: REVISIT_SECTIONS.map(([key, title]) => ({ key, title, form: 'PROSE' })),
} as never);

type RevisitKey = (typeof REVISIT_SECTIONS)[number][0];

const emptyNote = () => REVISIT_SECTIONS.map(([, title]) => ({ title, content: '' }));
const bodyOf = (sections: { title: string; content?: string }[], key: RevisitKey) =>
  sections[REVISIT_SECTIONS.findIndex(([k]) => k === key)]!.content ?? '';

/** The `SAME-DAY EARLIER VISIT(S)` block of `p25.txt`, verbatim. */
const PREQUEL = `### Earlier visit today (07:48 IST, status CLOSED_COMPLETE)
## Presenting Complaints
Shortness of breath on exertion and intermittent chest pain over the past two weeks.

## Past History
Not discussed

## Family History
Not discussed

## Drug History
Aspirin 81 milligrams daily was planned.

## Hospital Admissions
Not discussed

## General Examination & Vitals
Heart Rate is 88 and regular. Lungs are clear to auscultation bilaterally.

## Previous Diagnosis
Not discussed

## Reports
An electrocardiogram (ECG) and a troponin level were ordered.

## Current Diagnosis
The differential diagnosis included stable angina.

## Plan of Care
Aspirin 81 milligrams daily was planned.

(Copied to EMR by the clinician.)`;

/** The `TEST RESULTS` block of `p25.txt`, verbatim. */
const TEST_RESULTS = `- Hemoglobin: 10.2 g/dL (ref 13-17) [L]
- Fasting glucose: 142 mg/dL [H]`;

/** Turn 1's transcript, verbatim. */
const TURN1 = 'Good afternoon. Your reports are back.';

const grounding = (transcript: string): TurnGrounding => ({ transcript, sameDayPrequel: PREQUEL, testResults: TEST_RESULTS });

/** The evidence sentences, as the afternoon turn-1 patches (seq 66-68) carried them. */
const EXAM = 'Heart Rate is 88 and regular. Lungs are clear to auscultation bilaterally.';
const DIAGNOSIS = 'The differential diagnosis included stable angina (carried over from earlier visit).';
const DIAGNOSIS_SHORT = 'Stable angina (carried over).';
const ASPIRIN = 'Aspirin 81 milligrams daily was planned at the earlier visit.';
const RESULTS = 'Hemoglobin is 10.2 g/dL (ref 13-17) [L] and Fasting glucose is 142 mg/dL [H].';

describe('TASK-1022 D-GROUND — reference-only sentences never land in a CURRENT-visit section', () => {
  it('drops the turn-1 evidence sentences from the current sections', () => {
    const turn: ParsedTurn = {
      examination_and_vitals: { addition: EXAM },
      current_diagnosis: { addition: DIAGNOSIS },
      treatment_plan: { addition: ASPIRIN },
      new_complaints: { addition: DIAGNOSIS_SHORT },
    };
    const applied = applyTurn(emptyNote(), turn, revisit, grounding(TURN1));

    expect(bodyOf(applied.sections, 'examination_and_vitals')).toBe('');
    expect(bodyOf(applied.sections, 'current_diagnosis')).toBe('');
    expect(bodyOf(applied.sections, 'treatment_plan')).toBe('');
    expect(bodyOf(applied.sections, 'new_complaints')).toBe('');
    expect(applied.writes).toEqual([]);
    // EXAM is two sentences; each of the others one.
    expect(applied.ungroundedSentenceCount).toBe(5);
  });

  it('drops copied TEST RESULTS from a current section while the transcript has not mentioned them', () => {
    const applied = applyTurn(emptyNote(), { examination_and_vitals: { addition: RESULTS } }, revisit, grounding(TURN1));
    expect(bodyOf(applied.sections, 'examination_and_vitals')).toBe('');
  });

  it('keeps the same sentences in PRIOR sections — the guard never applies there', () => {
    const turn: ParsedTurn = {
      previous_diagnosis: { addition: DIAGNOSIS },
      last_visit_complaints: { addition: EXAM },
      investigations: { addition: RESULTS },
    };
    const applied = applyTurn(emptyNote(), turn, revisit, grounding(TURN1));

    expect(bodyOf(applied.sections, 'previous_diagnosis')).toBe(DIAGNOSIS);
    expect(bodyOf(applied.sections, 'last_visit_complaints')).toBe(EXAM);
    expect(bodyOf(applied.sections, 'investigations')).toBe(RESULTS);
    expect(applied.ungroundedSentenceCount).toBe(0);
  });

  it('never touches a section that is neither current nor prior (Additional Data)', () => {
    const applied = applyTurn(emptyNote(), { additional_data: { addition: EXAM } }, revisit, grounding(TURN1));
    expect(bodyOf(applied.sections, 'additional_data')).toBe(EXAM);
  });

  it('keeps a sentence grounded in the transcript: a shared number', () => {
    const transcript = `${TURN1} your hemoglobin is 10.2, which is low, and your fasting blood sugar is 142. which is high.`;
    const applied = applyTurn(emptyNote(), { examination_and_vitals: { addition: RESULTS } }, revisit, grounding(transcript));
    expect(bodyOf(applied.sections, 'examination_and_vitals')).toBe(RESULTS);
  });

  it('keeps a sentence grounded in the transcript: the dose, or the drug name alone', () => {
    const withDose = applyTurn(
      emptyNote(),
      { treatment_plan: { addition: ASPIRIN } },
      revisit,
      grounding(`${TURN1} Continue Aspirin 81 milligrams daily please cut down sugar in your diet`),
    );
    expect(bodyOf(withDose.sections, 'treatment_plan')).toBe(ASPIRIN);

    const nameOnly = applyTurn(emptyNote(), { treatment_plan: { addition: ASPIRIN } }, revisit, grounding(`${TURN1} we will keep the aspirin going`));
    expect(bodyOf(nameOnly.sections, 'treatment_plan')).toBe(ASPIRIN);
  });

  it('drops only the reference-only sentence of a mixed addition, keeping the grounded one verbatim', () => {
    const grounded = 'The ECG and the troponin from this morning were normal, so the breathlessness is most likely from the anemia.';
    const transcript = `${TURN1} The ECG and the troponin from this morning were normal, so the breathlessness is most likely from the anemia.`;
    const applied = applyTurn(emptyNote(), { examination_and_vitals: { addition: `${EXAM}\n\n${grounded}` } }, revisit, grounding(transcript));
    expect(bodyOf(applied.sections, 'examination_and_vitals')).toBe(grounded);
    expect(applied.ungroundedSentenceCount).toBe(2);
  });

  it('keeps a sentence the reference does not support, even when the transcript does not either (conservative)', () => {
    const novel = 'Patient reports ankle swelling since last week.';
    const applied = applyTurn(emptyNote(), { new_complaints: { addition: novel } }, revisit, grounding(TURN1));
    expect(bodyOf(applied.sections, 'new_complaints')).toBe(novel);
  });

  it('is a no-op without grounding input, and without reference text', () => {
    const turn: ParsedTurn = { examination_and_vitals: { addition: EXAM } };
    expect(bodyOf(applyTurn(emptyNote(), turn, revisit).sections, 'examination_and_vitals')).toBe(EXAM);
    expect(bodyOf(applyTurn(emptyNote(), turn, revisit, { transcript: TURN1 }).sections, 'examination_and_vitals')).toBe(EXAM);
  });

  it('filters a first-write revision the same way as an addition', () => {
    const applied = applyTurn(emptyNote(), { current_diagnosis: { revision: DIAGNOSIS } }, revisit, grounding(TURN1));
    expect(bodyOf(applied.sections, 'current_diagnosis')).toBe('');
    expect(applied.writes).toEqual([]);
  });
});
