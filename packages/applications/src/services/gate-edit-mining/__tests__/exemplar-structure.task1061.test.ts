/**
 * TASK-1061 OD-2 — an exemplar carries STRUCTURE only.
 *
 * Another patient's approved note reached a new patient's pre-summary as a "style" example and
 * the model copied its facts. Whatever prompt an exemplar may ever reach, it must carry headings,
 * section order and line/sentence shape — never a drug, dose, number, date, name or finding.
 *
 *  - (b) the transform itself, on patient A's note with distinctive facts;
 *  - the retriever (the ONE read that hands stored exemplars to a prompt) returns structure only,
 *    so an exemplar already stored in full is stripped at use (defence in depth);
 *  - the STYLE REFERENCE renderer applies the transform again and no longer labels the section as
 *    notes from other patients.
 */
import { describe, expect, it, vi } from 'vitest';
import { toStructureOnlyExemplar } from '../exemplar-structure';
import { GateEditMiningService } from '../gate-edit-mining.service';
import { styleReferenceContent, STYLE_REFERENCE_EXEMPLARS_GUIDANCE } from '../../consultation/prompt/style-reference';

const TENANT = 'tenant-1061';

/** Patient A's approved note — every fact in it is distinctive enough to grep for. */
export const PATIENT_A_NOTE = [
  'Subjective:',
  'Mr. Arun Kumar reports improved thirst since the last visit. Father had MI at 52.',
  'Objective:',
  '- BP 142/88, pulse 76',
  '- HbA1c 8.4',
  'Assessment: Type 2 diabetes, suboptimally controlled.',
  '## Plan',
  '1. Metformin increased to 1000 mg twice daily.',
  '2. Amlodipine 5 mg started.',
  '3. Review in four weeks with Dr. Rao on 12/11/2026.',
].join('\n');

/** Everything about patient A that must never appear in another patient's prompt. */
export const PATIENT_A_FACTS = [
  'metformin',
  'amlodipine',
  '1000 mg',
  '1000',
  '5 mg',
  'four weeks',
  'four',
  'HbA1c',
  '8.4',
  '142/88',
  '76',
  '52',
  'thirst',
  'diabetes',
  'Arun',
  'Kumar',
  'Rao',
  '12/11/2026',
  'twice daily',
  'MI',
];

function expectNoFacts(text: string): void {
  for (const fact of PATIENT_A_FACTS) {
    expect(text.toLowerCase(), `leaked "${fact}"`).not.toMatch(new RegExp(`\\b${fact.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`));
  }
}

describe('toStructureOnlyExemplar — (b) patient A`s note keeps its layout and loses every fact', () => {
  const skeleton = toStructureOnlyExemplar(PATIENT_A_NOTE);

  it('contains none of patient A`s facts', () => {
    expectNoFacts(skeleton);
  });

  it('keeps every heading, in order', () => {
    const headings = ['Subjective:', 'Objective:', 'Assessment:', '## Plan'];
    const positions = headings.map((heading) => skeleton.indexOf(heading));
    for (const [index, position] of positions.entries()) expect(position, headings[index]).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('keeps the line count and the bullet / numbering shape', () => {
    const lines = skeleton.split('\n');
    expect(lines).toHaveLength(PATIENT_A_NOTE.split('\n').length);
    expect(lines[3]).toMatch(/^- /);
    expect(lines[4]).toMatch(/^- /);
    expect(lines[7]).toMatch(/^1\. /);
    expect(lines[8]).toMatch(/^2\. /);
    expect(lines[9]).toMatch(/^3\. /);
  });

  it('replaces values with TYPED placeholders', () => {
    expect(skeleton).toContain('<DRUG>');
    expect(skeleton).toContain('<DOSE>');
    expect(skeleton).toContain('<VALUE>');
    expect(skeleton).toContain('<DATE>');
    expect(skeleton).toContain('<NAME>');
    expect(skeleton).toContain('<FINDING>');
    expect(skeleton.split('\n')[8]).toMatch(/^2\. <DRUG> <DOSE>/);
    expect(skeleton.split('\n')[5]).toMatch(/^Assessment: <FINDING>.*\.$/);
  });

  it('leaves nothing but headings, placeholders and punctuation', () => {
    const residue = skeleton
      .replace(/^(Subjective:|Objective:|## Plan)$/gm, '')
      .replace(/^Assessment:/m, '')
      .replace(/^\d+\. /gm, '')
      .replace(/<(DRUG|DOSE|VALUE|DATE|NAME|FINDING)>/g, '');
    expect(residue).not.toMatch(/[A-Za-z0-9]/);
  });

  it('is idempotent — a skeleton stays the same skeleton', () => {
    expect(toStructureOnlyExemplar(skeleton)).toBe(skeleton);
  });

  it('does not keep a heading that is itself a clinical fact (when unsure, replace)', () => {
    const out = toStructureOnlyExemplar('Hypertension:\n- on treatment');
    expect(out).not.toMatch(/hypertension/i);
    expect(out.split('\n')).toHaveLength(2);
  });

  it('maps redaction tokens to placeholders', () => {
    expect(toStructureOnlyExemplar('Seen with [PERSON_1] on [REDACTED].')).not.toMatch(/PERSON|REDACTED/);
  });
});

describe('the retriever hands a prompt STRUCTURE only, even for an exemplar stored in full', () => {
  // TASK-1062 D-3: the skeleton is stored at save time (`structureAfter`) and is the only column read.
  it('returns the stored structure and none of the stored redactedAfter facts', async () => {
    const findTopForRetrieval = vi.fn(async () => [
      { tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN', redactedAfter: PATIENT_A_NOTE, structureAfter: toStructureOnlyExemplar(PATIENT_A_NOTE) },
    ]);
    const service = new GateEditMiningService({ findTopForRetrieval } as never, { emit: vi.fn() } as never, { get: vi.fn() } as never);

    const rows = await service.retrieveExemplars({ tenantId: TENANT, limit: 3 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(TENANT);
    expect(rows[0]!.redactedAfter).toBe(toStructureOnlyExemplar(PATIENT_A_NOTE));
    expectNoFacts(rows[0]!.redactedAfter as string);
  });

  it('skips a row stored before structureAfter existed rather than reading its redactedAfter', async () => {
    const findTopForRetrieval = vi.fn(async () => [{ tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN', redactedAfter: PATIENT_A_NOTE, structureAfter: null }]);
    const service = new GateEditMiningService({ findTopForRetrieval } as never, { emit: vi.fn() } as never, { get: vi.fn() } as never);

    await expect(service.retrieveExemplars({ tenantId: TENANT, limit: 3 })).resolves.toEqual([]);
  });
});

describe('the STYLE REFERENCE renderer', () => {
  it('re-applies the transform and labels the section as layout only', () => {
    const content = styleReferenceContent({ exemplars: { version: 'v1', text: PATIENT_A_NOTE } }) as string;

    expect(content).toContain('NOTE STRUCTURE EXAMPLES (layout only — contains no patient facts)');
    expect(content).not.toMatch(/DIFFERENT PATIENTS/i);
    expect(content).toContain('Subjective:');
    expectNoFacts(content);
  });

  it('the guidance no longer invites reading the section as notes', () => {
    expect(STYLE_REFERENCE_EXEMPLARS_GUIDANCE).toContain('NOTE STRUCTURE EXAMPLES');
    expect(STYLE_REFERENCE_EXEMPLARS_GUIDANCE).not.toMatch(/APPROVED NOTES/);
  });
});
