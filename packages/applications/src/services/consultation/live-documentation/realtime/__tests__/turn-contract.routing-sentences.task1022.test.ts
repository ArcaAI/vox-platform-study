/**
 * TASK-1022 (L-POLISH R1) — same-turn routing works per SENTENCE / bullet line, not per whole addition.
 *
 * Live replay run 4, afternoon, turn 2 (`section.patch` frames 112/114/115; " / " in the ticket was a
 * line break). The three additions differ AS WHOLES, so the whole-addition grouping formed no group
 * and the log showed `turnCrossSectionDuplicates=1`. Line by line, every prescription is a repeat of
 * a Treatment Plan line. Synthetic patient; no PHI.
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate } from '../../../../document-template/document-template-compiler';
import { applyTurn } from '../turn-contract';

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

/** Frame 112, verbatim. */
const CURRENT_MEDICATIONS = [
  '- Feros sulfate 325 milligrams by mouth once daily after food for 3 months.',
  '- Metformin 500mg/mouth twice daily with meals.',
  '- Continue Aspirin 81 milligrams daily.',
].join('\n');

/** Frame 114, verbatim. */
const TREATMENT_PLAN = [
  '- Start Feros sulfate 325 milligrams by mouth once daily after food for 3 months.',
  '- Metformin 500mg/mouth twice daily with meals.',
  '- Continue Aspirin 81 milligrams daily.',
  '- Please cut down sugar in your diet and walk 30 minutes every day.',
].join('\n');

/** Frame 115, verbatim. */
const ADDITIONAL_DATA = 'Patient is starting Feros sulfate 325 milligrams by mouth once daily after food for 3 months.';

describe('TASK-1022 R1 — same-turn routing groups SENTENCES across sections', () => {
  it('run 4 turn 2: Treatment Plan keeps its four lines; Current Medications and Additional Data write nothing', () => {
    const result = applyTurn(
      emptyNote(),
      {
        current_medications: { addition: CURRENT_MEDICATIONS },
        treatment_plan: { addition: TREATMENT_PLAN },
        additional_data: { addition: ADDITIONAL_DATA },
      },
      revisit,
    );

    expect(result.writes.map((w) => [w.sectionKey, w.mode, w.content])).toEqual([['treatment_plan', 'append', TREATMENT_PLAN]]);
    expect(bodyOf(result.sections, 'treatment_plan')).toBe(TREATMENT_PLAN);
    expect(bodyOf(result.sections, 'current_medications')).toBe('');
    expect(bodyOf(result.sections, 'additional_data')).toBe('');
    expect(result.crossSectionDuplicateCount).toBe(0);
  });

  it('keeps a NON-plan sentence of a mixed addition verbatim and moves only the plan sentence', () => {
    const reported = 'Patient reports feeling tired in the evenings.';
    const result = applyTurn(
      emptyNote(),
      {
        treatment_plan: { addition: TREATMENT_PLAN },
        additional_data: { addition: `${ADDITIONAL_DATA} ${reported}` },
      },
      revisit,
    );

    expect(result.writes.map((w) => [w.sectionKey, w.content])).toEqual([
      ['treatment_plan', TREATMENT_PLAN],
      ['additional_data', reported],
    ]);
  });

  it('keeps the unduplicated lines of Current Medications and drops only the ones the plan carries', () => {
    const ongoing = '- Atorvastatin 20 milligrams at night for cholesterol, ongoing since 2021.';
    const result = applyTurn(
      emptyNote(),
      {
        current_medications: { addition: `${CURRENT_MEDICATIONS}\n${ongoing}` },
        treatment_plan: { addition: TREATMENT_PLAN },
      },
      revisit,
    );

    expect(result.writes.map((w) => [w.sectionKey, w.content])).toEqual([
      ['current_medications', ongoing],
      ['treatment_plan', TREATMENT_PLAN],
    ]);
  });

  it('a repeated NON-plan sentence is still written in both sections (flag, never drop)', () => {
    const finding = 'Patient reports feeling tired in the evenings for two weeks.';
    const result = applyTurn(emptyNote(), { new_complaints: { addition: finding }, additional_data: { addition: finding } }, revisit);

    expect(result.writes.map((w) => w.sectionKey)).toEqual(['new_complaints', 'additional_data']);
  });

  it('a changed dose is NOT the same sentence — the number multiset still decides', () => {
    const result = applyTurn(
      emptyNote(),
      {
        current_medications: { addition: '- Metformin 1000mg/mouth twice daily with meals.' },
        treatment_plan: { addition: '- Metformin 500mg/mouth twice daily with meals.' },
      },
      revisit,
    );

    expect(result.writes.map((w) => w.sectionKey)).toEqual(['current_medications', 'treatment_plan']);
  });
});
