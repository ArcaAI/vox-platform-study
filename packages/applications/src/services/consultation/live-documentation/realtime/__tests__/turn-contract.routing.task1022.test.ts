/**
 * TASK-1022 (OD-2, folded in) — live section ROUTING on the per-turn lane.
 *
 * Built from a live replay (gemma-4-e2b, ArcaAI revisit template `arcaai-gen-soap-revisit`):
 *
 *  (a) `treatment_plan` was never patched. Near-identical plan text was APPENDED to
 *      `current_medications`, `additional_data` AND `instructions_and_orders` in the same turn.
 *  (b) turn 1 appended the placeholder "No new instructions or orders were stated in the current
 *      transcript." to `instructions_and_orders`, and it survived beside the real orders.
 *
 * The strings below are the replay's own (synthetic patient; no PHI).
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate } from '../../../../document-template/document-template-compiler';
import { applyTurn, isNothingStatedPlaceholder, parseTurnJson } from '../turn-contract';

/** The revisit template's eleven sections, keys and titles as the live prompt (`p29`) showed them. */
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

function revisitNote(bodies: Partial<Record<RevisitKey, string>> = {}) {
  return REVISIT_SECTIONS.map(([key, title]) => ({ title, content: bodies[key] ?? '' }));
}

const bodyOf = (sections: { title: string; content?: string }[], key: RevisitKey) =>
  sections[REVISIT_SECTIONS.findIndex(([k]) => k === key)]!.content ?? '';

/** Evidence (b), verbatim. */
const PLACEHOLDER = 'No new instructions or orders were stated in the current transcript.';

/** Evidence (a), verbatim — frame 121 (`current_medications`) and frames 123/124. */
const PLAN_NO_VERB =
  '- Feros sulfate 325 milligrams by mouth once daily after food for 3 months. - Metformin 500mg/mouth twice daily with meals. Continue Aspirin 81 milligrams daily please cut down sugar in your diet and walk 30 minutes every day.';
const PLAN_STARTING =
  '- I am starting Feros sulfate 325 milligrams by mouth once daily after food for 3 months. - Metformin 500mg/mouth twice daily with meals. Continue Aspirin 81 milligrams daily please cut down sugar in your diet and walk 30 minutes every day.';

/** Frame 180 (`follow_up_plan`), verbatim. */
const FOLLOW_UP = 'Come back in four weeks with a repeat hemoglobin and an HbA1c go to the emergency department if you get chest pain.';

describe('TASK-1022 — a "nothing stated" placeholder is not content', () => {
  it.each([
    PLACEHOLDER,
    'No new instructions or orders were stated.',
    'No instructions stated in the current transcript',
    '- No new orders.',
    'Not discussed.',
    'not discussed',
    '(Not discussed)',
    'Not mentioned',
    'Not stated in the current transcript.',
    'Medications were not mentioned in the current transcript.',
    'None reported.',
    'N/A',
    'n/a.',
    'Not applicable.',
    'Nothing new was reported in this turn.',
    'Not discussed. Not mentioned.',
  ])('recognises %j', (text) => {
    expect(isNothingStatedPlaceholder(text)).toBe(true);
  });

  it.each([
    'No chest pain reported',
    'No chest pain reported.',
    'Patient denies chest pain.',
    'None',
    'Nil',
    'No known drug allergies.',
    'Not discussed: patient declined HbA1c.',
    'Metformin 500 mg twice daily.',
    `${PLACEHOLDER} Metformin 500 mg twice daily.`,
    '',
  ])('keeps %j (a finding, a clinical answer, or mixed with one)', (text) => {
    expect(isNothingStatedPlaceholder(text)).toBe(false);
  });

  it('drops the evidence placeholder addition — no write, the section stays empty', () => {
    const result = applyTurn(revisitNote(), { instructions_and_orders: { addition: PLACEHOLDER } }, revisit);

    expect(result.writes).toEqual([]);
    expect(bodyOf(result.sections, 'instructions_and_orders')).toBe('');
  });

  it('drops a placeholder REVISION on an empty section too — it is not first content', () => {
    const result = applyTurn(revisitNote(), { treatment_plan: { revision: 'Not discussed.' } }, revisit);

    expect(result.writes).toEqual([]);
  });

  it('strips the placeholder SENTENCE from a mixed addition and keeps the clinical sentence verbatim', () => {
    const result = applyTurn(revisitNote(), { instructions_and_orders: { addition: `${PLACEHOLDER} Repeat hemoglobin in four weeks.` } }, revisit);

    expect(result.writes.map((w) => [w.sectionKey, w.mode, w.content])).toEqual([
      ['instructions_and_orders', 'append', 'Repeat hemoglobin in four weeks.'],
    ]);
  });

  it('KEEPS a pertinent negative ("No chest pain reported")', () => {
    const result = applyTurn(revisitNote(), { new_complaints: { addition: 'No chest pain reported' } }, revisit);

    expect(result.writes.map((w) => w.content)).toEqual(['No chest pain reported']);
  });

  it('parseTurnJson drops a placeholder the model emitted, exactly like a JSON null', () => {
    const turn = parseTurnJson(JSON.stringify({ instructions_and_orders: { addition: PLACEHOLDER, revision: null, contradiction: null } }), revisit);

    expect(turn).toEqual({});
  });

  it('REPLACES a section whose stored machine content is ONLY a placeholder when a real addition arrives (evidence b)', () => {
    const orders = '- Feros sulfate 325 milligrams by mouth once daily after food for 3 months.';
    const result = applyTurn(revisitNote({ instructions_and_orders: PLACEHOLDER }), { instructions_and_orders: { addition: orders } }, revisit);

    expect(result.writes.map((w) => [w.sectionKey, w.mode, w.content, w.contradiction])).toEqual([
      ['instructions_and_orders', 'replace', orders, undefined],
    ]);
    expect(bodyOf(result.sections, 'instructions_and_orders')).toBe(orders);
  });

  it('still APPENDS when the stored content is real — the cleanup is for a placeholder-only body', () => {
    const result = applyTurn(
      revisitNote({ instructions_and_orders: 'Repeat hemoglobin in four weeks.' }),
      { instructions_and_orders: { addition: 'Metformin 500 mg twice daily with meals.' } },
      revisit,
    );

    expect(result.writes.map((w) => w.mode)).toEqual(['append']);
    expect(bodyOf(result.sections, 'instructions_and_orders')).toBe('Repeat hemoglobin in four weeks.\n\nMetformin 500 mg twice daily with meals.');
  });

  it('leaves a placeholder-only body untouched when the turn says nothing real about it', () => {
    const result = applyTurn(
      revisitNote({ instructions_and_orders: PLACEHOLDER }),
      { instructions_and_orders: { addition: 'Not discussed.' } },
      revisit,
    );

    expect(result.writes).toEqual([]);
    expect(bodyOf(result.sections, 'instructions_and_orders')).toBe(PLACEHOLDER);
  });
});

describe('TASK-1022 — one turn writing near-identical text into several sections keeps it in ONE', () => {
  it('evidence (a): the prescription lands in Treatment Plan only, and nowhere else', () => {
    const result = applyTurn(
      revisitNote({ current_medications: 'Aspirin 81 milligrams daily was started for stable angina (record, date not stated).' }),
      {
        current_medications: { addition: PLAN_NO_VERB },
        additional_data: { addition: PLAN_STARTING },
        instructions_and_orders: { addition: PLAN_STARTING },
      },
      revisit,
    );

    expect(result.writes.map((w) => [w.sectionKey, w.mode, w.content])).toEqual([['treatment_plan', 'append', PLAN_STARTING]]);
    expect(bodyOf(result.sections, 'treatment_plan')).toBe(PLAN_STARTING);
    expect(bodyOf(result.sections, 'current_medications')).toBe(
      'Aspirin 81 milligrams daily was started for stable angina (record, date not stated).',
    );
    expect(bodyOf(result.sections, 'additional_data')).toBe('');
    expect(bodyOf(result.sections, 'instructions_and_orders')).toBe('');
  });

  it('keeps it in the plan section when the model already wrote it there too', () => {
    const result = applyTurn(
      revisitNote(),
      { current_medications: { addition: PLAN_NO_VERB }, treatment_plan: { addition: PLAN_STARTING } },
      revisit,
    );

    expect(result.writes.map((w) => w.sectionKey)).toEqual(['treatment_plan']);
  });

  it('appends after the plan section`s own, different contribution this turn', () => {
    const own = 'Iron studies to be reviewed next visit.';
    const result = applyTurn(
      revisitNote(),
      { treatment_plan: { addition: own }, current_medications: { addition: PLAN_NO_VERB }, instructions_and_orders: { addition: PLAN_STARTING } },
      revisit,
    );

    expect(result.writes.map((w) => [w.sectionKey, w.content])).toEqual([['treatment_plan', `${own}\n\n${PLAN_STARTING}`]]);
  });

  it('routes an order / return instruction to Follow-up Plan when no member is an orders section', () => {
    const result = applyTurn(revisitNote(), { current_medications: { addition: FOLLOW_UP }, additional_data: { addition: FOLLOW_UP } }, revisit);

    expect(result.writes.map((w) => [w.sectionKey, w.content])).toEqual([['follow_up_plan', FOLLOW_UP]]);
  });

  it('prefers a MEMBER of the kind (Instructions & Orders) over moving an order elsewhere', () => {
    const result = applyTurn(revisitNote(), { additional_data: { addition: FOLLOW_UP }, instructions_and_orders: { addition: FOLLOW_UP } }, revisit);

    expect(result.writes.map((w) => w.sectionKey)).toEqual(['instructions_and_orders']);
  });

  it('text of NO routable kind is still written to every section and FLAGGED (owner decision TASK-1001, unchanged)', () => {
    const para = 'Hemoglobin is 10.2 g/dL (ref 13-17) and it is low. Fasting glucose is 142 mg/dL and it is high.';
    const result = applyTurn(revisitNote(), { last_visit_complaints: { addition: para }, investigations: { addition: para } }, revisit);

    expect(result.writes.map((w) => w.sectionKey)).toEqual(['last_visit_complaints', 'investigations']);
    expect(result.writes[1]!.duplicates?.[0]).toMatchObject({ kind: 'duplicate', duplicateOf: 'last_visit_complaints' });
  });

  it('does nothing to a single section`s plan text — only a SAME-TURN repeat is routed', () => {
    const result = applyTurn(revisitNote(), { current_medications: { addition: PLAN_NO_VERB } }, revisit);

    expect(result.writes.map((w) => w.sectionKey)).toEqual(['current_medications']);
  });

  it('never touches a contradiction-backed revision', () => {
    const result = applyTurn(
      revisitNote({ current_medications: 'Aspirin 75 mg daily.' }),
      {
        current_medications: { revision: PLAN_NO_VERB, contradiction: 'Clinician changed the regimen.' },
        instructions_and_orders: { addition: PLAN_STARTING },
      },
      revisit,
    );

    expect(result.writes.map((w) => w.sectionKey).sort()).toEqual(['current_medications', 'instructions_and_orders']);
  });

  it('is a no-op for a template with NO plan-like section (keys vary per template)', () => {
    const noPlan = compileDocumentTemplate({
      title: 'Referral Letter',
      sections: [
        { key: 'medications', title: 'Medications', form: 'PROSE' },
        { key: 'extra', title: 'Additional Data', form: 'PROSE' },
      ],
    } as never);

    const result = applyTurn(
      [
        { title: 'Medications', content: '' },
        { title: 'Additional Data', content: '' },
      ],
      { medications: { addition: PLAN_NO_VERB }, extra: { addition: PLAN_STARTING } },
      noPlan,
    );

    expect(result.writes.map((w) => w.sectionKey)).toEqual(['medications', 'extra']);
  });

  it('matches a differently-keyed template by TITLE ("Management" is a plan section)', () => {
    const other = compileDocumentTemplate({
      title: 'Clinic Note',
      sections: [
        { key: 'meds', title: 'Medications', form: 'PROSE' },
        { key: 'mgmt', title: 'Management', form: 'PROSE' },
        { key: 'other', title: 'Other', form: 'PROSE' },
      ],
    } as never);

    const result = applyTurn(
      [
        { title: 'Medications', content: '' },
        { title: 'Management', content: '' },
        { title: 'Other', content: '' },
      ],
      { meds: { addition: PLAN_NO_VERB }, other: { addition: PLAN_STARTING } },
      other,
    );

    expect(result.writes.map((w) => [w.sectionKey, w.content])).toEqual([['mgmt', PLAN_STARTING]]);
  });

  it('keeps a cross-TURN repeat as it was: written and flagged, never dropped', () => {
    const result = applyTurn(revisitNote({ current_medications: PLAN_NO_VERB }), { instructions_and_orders: { addition: PLAN_STARTING } }, revisit);

    expect(result.writes.map((w) => w.sectionKey)).toEqual(['instructions_and_orders']);
    expect(result.writes[0]!.duplicates?.[0]).toMatchObject({ kind: 'duplicate', duplicateOf: 'current_medications' });
  });
});
