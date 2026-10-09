/**
 * TASK-1054 (defect A) — live sections carried CHANGE-NARRATION instead of clinical text.
 *
 * Observed live 2026-10-09 (dev cluster, gemma-4-e2b, ArcaAI template `arcaai-gen-soap-new-visit`):
 * the `section.patch` / `summary.snapshot` bodies of four sections read like a diff of the note —
 * "The previous note stated no presenting complaints were recorded yet; this update adds the new
 * symptoms described by the patient." — and in encounter 2 the real content was appended AFTER that
 * sentence. The final note was unaffected.
 *
 * A sentence that describes the NOTE (the previous note, this update, what the update adds) rather
 * than the PATIENT is not content. It is dropped deterministically beside the TASK-1022 placeholder
 * guard, and a turn that is nothing but such sentences is a no-op. The filter is deliberately
 * narrow: a clinical sentence that merely contains "previous" survives.
 *
 * The observed strings are the replay's own (synthetic patient; no PHI).
 */
import { describe, expect, it } from 'vitest';

import { compileDocumentTemplate } from '../../../../document-template/document-template-compiler';
import { applyTurn, buildTurnResponseFormat, parseTurnJson, turnInstruction } from '../turn-contract';

const GEN_SECTIONS = [
  ['presenting_complaints', 'Presenting Complaints'],
  ['examination_and_vitals', 'General Examination & Vitals'],
  ['reports', 'Reports'],
  ['current_diagnosis', 'Current Diagnosis'],
  ['treatment_plan', 'Treatment Plan'],
] as const;

const gen = compileDocumentTemplate({
  title: 'General Medicine Consultation Note — New / Referral Visit',
  sections: GEN_SECTIONS.map(([key, title]) => ({ key, title, form: 'PROSE' })),
} as never);

type GenKey = (typeof GEN_SECTIONS)[number][0];

function note(bodies: Partial<Record<GenKey, string>> = {}) {
  return GEN_SECTIONS.map(([key, title]) => ({ title, content: bodies[key] ?? '' }));
}

/** The four sentences the live run published, one per section. */
const OBSERVED: ReadonlyArray<readonly [GenKey, string]> = [
  [
    'presenting_complaints',
    'The previous note stated no presenting complaints were recorded yet; this update adds the new symptoms described by the patient.',
  ],
  [
    'examination_and_vitals',
    'The previous note stated no examination or vitals were recorded yet; this update adds the current BP, pulse, heart sound, and chest findings.',
  ],
  ['reports', 'The previous note stated no reports were recorded yet; this update documents the requested tests.'],
  [
    'current_diagnosis',
    'The previous note stated no current diagnosis was recorded yet; this update introduces a working diagnosis based on clinical findings.',
  ],
];

const turnJson = (turn: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(GEN_SECTIONS.map(([key]) => [key, turn[key] ?? null])));

describe('TASK-1054 — change-narration never reaches a section', () => {
  it.each(OBSERVED)('drops the observed %s sentence at parse time', (key, sentence) => {
    const parsed = parseTurnJson(turnJson({ [key]: { addition: sentence, revision: null, contradiction: null } }), gen);
    expect(parsed).not.toBeNull();
    expect(parsed![key]).toBeUndefined();
  });

  it.each(OBSERVED)('drops the observed %s sentence in the fold, even from a hand-built turn', (key, sentence) => {
    const applied = applyTurn(note(), { [key]: { addition: sentence } }, gen);
    expect(applied.writes).toEqual([]);
    expect(applied.sections.every((section) => section.content === '')).toBe(true);
  });

  it('drops a meta REVISION on an empty section — no first write of narration', () => {
    const [key, sentence] = OBSERVED[3]!;
    const applied = applyTurn(note(), { [key]: { revision: sentence } }, gen);
    expect(applied.writes).toEqual([]);
  });

  it('keeps only the clinical sentence when one field mixes narration and content', () => {
    const addition =
      'The previous note stated no examination or vitals were recorded yet; this update adds the current BP, pulse, heart sound, and chest findings. ' +
      'BP 140/90 mmHg, pulse 88/min, S1 S2 normal, chest clear.';
    const parsed = parseTurnJson(turnJson({ examination_and_vitals: { addition, revision: null, contradiction: null } }), gen);
    expect(parsed!.examination_and_vitals).toEqual({ addition: 'BP 140/90 mmHg, pulse 88/min, S1 S2 normal, chest clear.' });

    const applied = applyTurn(note(), { examination_and_vitals: { addition } }, gen);
    expect(applied.writes).toHaveLength(1);
    expect(applied.writes[0]!.content).toBe('BP 140/90 mmHg, pulse 88/min, S1 S2 normal, chest clear.');
  });

  it('keeps only the clinical text of a justified revision', () => {
    const prior = note({ current_diagnosis: 'Viral fever.' });
    const applied = applyTurn(
      prior,
      {
        current_diagnosis: {
          revision: 'This update revises the working diagnosis. Community-acquired pneumonia.',
          contradiction: 'Chest X-ray now shows right lower lobe consolidation.',
        },
      },
      gen,
    );
    expect(applied.writes).toHaveLength(1);
    expect(applied.writes[0]!.mode).toBe('replace');
    expect(applied.writes[0]!.content).toBe('Community-acquired pneumonia.');
    // `contradiction` is the REASON for the replace, not section content — it is kept as written.
    expect(applied.writes[0]!.contradiction).toEqual({ reason: 'Chest X-ray now shows right lower lobe consolidation.' });
  });

  it.each([
    'The note now includes the new symptoms described by the patient.',
    'This update adds the new symptoms described by the patient.',
    'Adds the new BP and pulse readings.',
    'The existing section had no reports recorded yet.',
    'No presenting complaints were recorded yet.',
    'The current summary now lists the requested tests.',
  ])('drops the meta sentence %j', (sentence) => {
    const parsed = parseTurnJson(turnJson({ reports: { addition: sentence, revision: null, contradiction: null } }), gen);
    expect(parsed!.reports).toBeUndefined();
  });

  it.each([
    'Previous MI in 2019.',
    'HbA1c was noted as 7.8 percent at a previous visit.',
    'Prior history of pulmonary tuberculosis, treated in 2015.',
    'Previous summary: fever and cough for three days.',
    'Previous notes show a penicillin allergy (rash).',
    'Current medications include metformin 500 mg twice daily.',
    'No chest pain reported.',
    'No known drug allergies.',
    'Patient was told the biopsy result is not available yet.',
  ])('keeps the clinical sentence %j', (sentence) => {
    const parsed = parseTurnJson(turnJson({ reports: { addition: sentence, revision: null, contradiction: null } }), gen);
    expect(parsed!.reports).toEqual({ addition: sentence });

    const applied = applyTurn(note(), { reports: { addition: sentence } }, gen);
    expect(applied.writes.map((write) => write.content)).toEqual([sentence]);
  });

  it('an all-meta turn over an existing note changes nothing', () => {
    const prior = note({
      presenting_complaints: 'Fever for three days with dry cough.',
      examination_and_vitals: 'BP 130/80 mmHg.',
    });
    const turn = Object.fromEntries(OBSERVED.map(([key, sentence]) => [key, { addition: sentence }]));
    const applied = applyTurn(prior, turn, gen);
    expect(applied.writes).toEqual([]);
    expect(applied.refusals).toEqual([]);
    expect(applied.sections).toEqual(prior);
  });

  it('a body that is ONLY an older turn’s narration is replaced by real content, not appended to', () => {
    const [key, sentence] = OBSERVED[0]!;
    const prior = note({ [key]: sentence });
    const applied = applyTurn(prior, { [key]: { addition: 'Fever for three days with dry cough.' } }, gen);
    expect(applied.writes).toEqual([expect.objectContaining({ sectionKey: key, mode: 'replace', content: 'Fever for three days with dry cough.' })]);
    expect(applied.sections[0]!.content).toBe('Fever for three days with dry cough.');
  });
});

describe('TASK-1054 — the contract asks for clinical text, never for a description of the update', () => {
  const instruction = turnInstruction(gen);
  const schema = buildTurnResponseFormat(gen).json_schema as {
    properties: Record<string, { description: string; properties: Record<string, { description: string }> }>;
  };

  it('the prose instruction forbids narrating the note or the update', () => {
    expect(instruction).toContain('WHAT TO EMIT THIS TURN:');
    expect(instruction).toMatch(/clinical text itself/i);
    expect(instruction).toMatch(/never describe the note, the previous note, or what (?:this|the) update adds/i);
    expect(instruction).not.toMatch(/CONTRIBUTION/);
  });

  it('the schema descriptions say the same thing, per section', () => {
    for (const [key] of GEN_SECTIONS) {
      const section = schema.properties[key]!;
      expect(section.description).not.toMatch(/contribution/i);
      expect(section.properties.addition!.description).toMatch(/clinical text/i);
      expect(section.properties.addition!.description).toMatch(/never describe the note/i);
      expect(section.properties.revision!.description).toMatch(/never describe the note/i);
    }
  });
});
