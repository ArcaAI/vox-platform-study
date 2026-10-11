/**
 * TASK-1061 N-1 / OD-1 — another patient's approved note never reaches this patient's prompt.
 *
 * A brand-new patient's pre-summary and live note carried another patient's facts ("metformin
 * increased to 1000 mg", "amlodipine 5 mg started", "review in four weeks"): the assembly put the
 * doctor's approved notes for OTHER patients into every non-finalizer prompt as few-shot style
 * examples, and a small model copied them.
 *
 * OD-1: approved-note exemplars may appear ONLY in the final-note finalizer. The finalizer (the
 * composed note plan) never received them, so the fix is to stop sending them anywhere else.
 *
 *  - (a) pre-summary, live and legacy summary prompts for patient B, while the exemplar store holds
 *    patient A's approved note: none of A's text, no exemplar section, no retrieval at all;
 *  - (c) the finalizer: still no exemplars, in its system message or in the STYLE REFERENCE
 *    background it carries — the doctor's own writing style and redaction rules stay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT = 'tenant-1061';
const STYLE = 'Terse bullets. DNA-STYLE-MARKER';
const RULES = '- never include the patient employer RULES-MARKER';
const PATIENT_B_TRANSCRIPT = 'Doctor: what brings you in? Patient: a sore throat for two days. PATIENT-B-MARKER';

const PATIENT_A_NOTE = [
  'Subjective:',
  'Reports improved thirst. Father had MI at 52.',
  'Objective:',
  '- HbA1c 8.4',
  'Plan:',
  '1. Metformin increased to 1000 mg twice daily.',
  '2. Amlodipine 5 mg started.',
  '3. Review in four weeks.',
].join('\n');
const PATIENT_A_FACTS = ['metformin', '1000 mg', 'amlodipine', '5 mg', 'review in four weeks', 'four weeks', 'HbA1c 8.4', '8.4', 'thirst'];

const resolution = { resolve: vi.fn() };
const templates = { findById: vi.fn() };
const dna = { findById: vi.fn() };
const retrieveExemplars = vi.fn();

async function service() {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  return new PromptAssemblyService(
    resolution as never,
    templates as never,
    dna as never,
    { get: vi.fn(() => TENANT) } as never,
    {
      retrieveExemplars,
    } as never,
  );
}

const patientB = {
  tenantId: TENANT,
  departmentId: 'dept-1',
  transcript: PATIENT_B_TRANSCRIPT,
  conversationLanguage: 'en',
  dnaStyleId: 'dna-1',
  dnaRedactionRulesText: RULES,
};

function expectNoPatientA(prompt: { systemPrompt: string; userPrompt: string }): void {
  const text = `${prompt.systemPrompt}\n${prompt.userPrompt}`.toLowerCase();
  for (const fact of PATIENT_A_FACTS) expect(text, `leaked "${fact}"`).not.toContain(fact.toLowerCase());
  expect(text).not.toMatch(/note structure examples|approved notes|different patients/);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolution.resolve.mockResolvedValue({ promptId: 'tpl-1', content: 'Write the note.\nTranscript:\n{{transcript}}', resolvedFrom: 'department' });
  templates.findById.mockResolvedValue({ id: 'tpl-1', metaData: null });
  dna.findById.mockResolvedValue({ styleText: STYLE });
  retrieveExemplars.mockResolvedValue([{ tenantId: TENANT, qualitySignal: 'APPROVED_CLEAN', redactedAfter: PATIENT_A_NOTE }]);
});

describe('(a) patient B`s non-finalizer prompts never carry patient A`s approved note', () => {
  it('pre-summary', async () => {
    const assembled = await (
      await service()
    ).assemble({ ...patientB, promptType: 'pre-summary', preSummaryVariant: 'dept-free', transcript: '', caseNotes: ['[case note] sore throat'] });

    expectNoPatientA(assembled);
    expect(retrieveExemplars).not.toHaveBeenCalled();
  });

  it('live lane', async () => {
    const assembled = await (await service()).assemble({ ...patientB, promptType: 'live' });

    expectNoPatientA(assembled);
    expect(assembled.userPrompt).toContain('PATIENT-B-MARKER');
    expect(retrieveExemplars).not.toHaveBeenCalled();
  });

  it('legacy summary', async () => {
    const assembled = await (await service()).assemble({ ...patientB, promptType: 'new-patient' });

    expectNoPatientA(assembled);
    expect(retrieveExemplars).not.toHaveBeenCalled();
  });

  it('keeps the doctor`s own writing style and redaction rules — preferences, not patient data', async () => {
    const assembled = await (await service()).assemble({ ...patientB, promptType: 'live' });

    expect(assembled.blocks?.[0]?.key).toBe('style_reference');
    expect(assembled.userPrompt).toContain('DNA-STYLE-MARKER');
    expect(assembled.userPrompt).toContain('RULES-MARKER');
    expect((assembled.platformPieces ?? []).map((piece) => piece.sourceKey)).not.toContain('style-reference-exemplars');
  });
});

describe('(c) the finalizer', () => {
  it('a composed note plan carries no exemplar and retrieves none', async () => {
    const assembled = await (
      await service()
    ).assemble({ ...patientB, noteInputBlocks: [{ key: 'encounter_1', label: 'Encounter 1 transcript', content: PATIENT_B_TRANSCRIPT }] });

    expectNoPatientA(assembled);
    expect(retrieveExemplars).not.toHaveBeenCalled();
  });

  it('the plan`s STYLE REFERENCE background is the doctor`s style and rules only', async () => {
    const content = (await (await service()).styleReference({ dnaStyleId: 'dna-1', dnaRedactionRulesText: RULES })) as string;

    expect(content).toContain('DNA-STYLE-MARKER');
    expect(content).toContain('RULES-MARKER');
    expectNoPatientA({ systemPrompt: '', userPrompt: content });
    expect(retrieveExemplars).not.toHaveBeenCalled();
  });
});
