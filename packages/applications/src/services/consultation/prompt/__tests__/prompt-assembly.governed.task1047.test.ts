/**
 * TASK-1047 D1 / FC-1 / FC-2 / FC-4 — `PromptAssemblyService` puts NO runtime value into the system
 * message, on any of its inputs.
 *
 * The composer (`composeMessages`, Lane L1) renders every placeholder as a pointer and its value as
 * a data block. What this service controls — and what these tests pin, at the composer's INPUT — is
 * everything else that reaches the system message:
 *
 *   - the instruction is the governed body exactly as resolved (no value substituted into it here);
 *   - the platform rules are the platform's own text;
 *   - every output-contract part is static, keyed text: the few-shot set version, the DNA style and
 *     the clinician's redaction rules are DATA, in the `style_reference` block;
 *   - the nine data sections keep their established block names through `blockAliases` instead of
 *     this service's old pointer substitution, so the scope carries REAL values;
 *   - the transcript is the LAST block (D9: stable context first, for the prefix cache);
 *   - the composed `governance` and the platform pieces travel on the result for the egress (FC-4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composeMessages, outputLanguageStep, platformRules, type ComposeMessagesInput, type SystemGovernance } from '@arcaai/workflow-contract';

vi.mock('@arcaai/workflow-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/workflow-contract')>();
  return { ...actual, composeMessages: vi.fn(actual.composeMessages) };
});

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn(), findByIdWithDecryptedFields: vi.fn() };
const mockDepartmentRepository = { findById: vi.fn() };

const TENANT = 'tenant-1047';
const VITALS = 'BP 155/95 VITALS-MARKER';
const PREVIOUS = 'PREVIOUS-VISITS-MARKER';
const TESTS = 'HbA1c 9.1 TEST-RESULTS-MARKER';
const STYLE = 'Terse bullets. DNA-STYLE-MARKER';
const RULES = '- never include the patient employer RULES-MARKER';
const EXEMPLAR = 'S: approved exemplar EXEMPLAR-MARKER';
const TRANSCRIPT = 'Doctor: how are you TRANSCRIPT-MARKER';
const RUNTIME_MARKERS = [VITALS, PREVIOUS, TESTS, STYLE, RULES, EXEMPLAR, TRANSCRIPT, 'Cardiology'];

async function getService(options: { exemplars?: unknown[] } = {}) {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  return new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    { get: vi.fn(() => TENANT) } as never,
    options.exemplars ? ({ retrieveExemplars: vi.fn(async () => options.exemplars) } as never) : undefined,
    undefined,
    mockDepartmentRepository as never,
  );
}

const base = { tenantId: TENANT, departmentId: 'dept-1', promptType: 'pre-summary' as const, transcript: TRANSCRIPT, conversationLanguage: 'en' };

function resolveBody(content: string) {
  mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'tpl-1', content, resolvedFrom: 'department' });
}

/** The ONE composer call this assembly made. */
function composerInput(): ComposeMessagesInput {
  const calls = vi.mocked(composeMessages).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)![0];
}

/** Everything the system message is built from, besides the governed instruction itself. */
function systemSideText(input: ComposeMessagesInput): string {
  return [input.platformRules, input.outputContract ?? '', ...(input.outputContractParts ?? []).map((part) => part.text)].join('\n');
}

beforeEach(() => {
  vi.mocked(composeMessages).mockClear();
  vi.clearAllMocks();
  mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', metaData: null });
  mockDepartmentRepository.findById.mockResolvedValue({ name: 'Cardiology' });
  mockDnaWritingStyleRepository.findById.mockResolvedValue({ styleText: STYLE });
});

describe('no runtime value is ever composed into the system side', () => {
  const BODY = 'Department {{context.current_department}}. Vitals {{context.safe_vitals}}. History {{context.formatted_previous_visits}}. Tests {{context.formatted_test_results}}. Transcript:\n{{transcript}}';

  it('hands the governed body over unrendered and keeps every value out of the rules and the contract', async () => {
    resolveBody(BODY);
    await (await getService({ exemplars: [{ redactedAfter: EXEMPLAR }] })).assemble({
      ...base,
      vitals: VITALS,
      previousVisits: PREVIOUS,
      testResults: TESTS,
      dnaStyleId: 'dna-1',
      dnaRedactionRulesText: RULES,
    });
    const input = composerInput();

    expect(input.resolvedPrompt).toEqual({ source: 'inline', content: BODY });
    expect(input.platformRules).toBe(platformRules());
    expect(input.outputContract).toBeUndefined();
    const systemSide = systemSideText(input);
    for (const marker of RUNTIME_MARKERS) expect(systemSide).not.toContain(marker);
  });

  it('binds REAL values in the scope — the composer, not this service, renders the pointers', async () => {
    resolveBody(BODY);
    await (await getService()).assemble({ ...base, vitals: VITALS, previousVisits: PREVIOUS });
    const scope = composerInput().scope as { context: Record<string, string>; transcript: string };

    expect(scope.context.safe_vitals).toBe(VITALS);
    expect(scope.context.formatted_previous_visits).toBe(PREVIOUS);
    expect(scope.transcript).toBe(TRANSCRIPT);
    expect(JSON.stringify(scope)).not.toContain('data section below');
  });

  it('a caller agent variable bound by path stays in the scope, never in the contract', async () => {
    mockPromptResolutionService.resolve.mockResolvedValue({
      promptId: 'tpl-1',
      content: 'x',
      resolvedFrom: 'agent',
      resolvedPrompt: { source: 'inline', content: 'Complaint [{{complaint}}] vitals {{vit}}.' },
      promptVariables: { complaint: { path: 'trigger.context.chief_complaint' }, vit: { path: 'trigger.context.formatted_vitals' } },
    });
    await (await getService()).assemble({ ...base, promptType: 'revisit' as never, vitals: VITALS });
    const input = composerInput();
    expect(systemSideText(input)).not.toContain(VITALS);
    expect((input.scope as Record<string, unknown>).vit).toBe(VITALS);
  });
});

describe('the established data-section names survive as blockAliases', () => {
  it('aliases each populated section variable — bare and namespaced — to its section block', async () => {
    resolveBody('{{transcript}} {{context.safe_vitals}} {{context.formatted_previous_visits}} {{context.formatted_test_results}} {{pre_summary_text}}');
    await (await getService()).assemble({ ...base, vitals: VITALS, previousVisits: PREVIOUS, testResults: TESTS, preSummaryText: 'DRAFT' });
    const aliases = composerInput().blockAliases ?? {};

    expect(aliases).toMatchObject({
      transcript: 'transcript',
      'context.transcript': 'transcript',
      'trigger.context.transcript': 'transcript',
      'variables.transcript': 'transcript',
      recent_vitals: 'recent_vitals',
      safe_vitals: 'recent_vitals',
      'context.safe_vitals': 'recent_vitals',
      formatted_vitals: 'recent_vitals',
      formatted_previous_visits: 'previous_case_notes_summary',
      'context.formatted_previous_visits': 'previous_case_notes_summary',
      formatted_test_results: 'test_results',
      'context.formatted_test_results': 'test_results',
      pre_summary_text: 'prior_draft',
    });
  });

  it('does not alias a section that is empty for this encounter — its own absence value is the data', async () => {
    resolveBody('Vitals {{context.safe_vitals}}.');
    await (await getService()).assemble({ ...base });
    const input = composerInput();
    expect(input.blockAliases ?? {}).not.toHaveProperty('context.safe_vitals');
    expect((input.scope as { context: Record<string, string> }).context.safe_vitals).toBe('Not available');
  });

  it('points every DNA style slot at the style_reference block', async () => {
    resolveBody('Style: {{style_DNA_doctor_department_medicine}} / {{context.dna_style_text}}');
    await (await getService()).assemble({ ...base, dnaStyleId: 'dna-1' });
    expect(composerInput().blockAliases).toMatchObject({
      style_DNA_doctor_department_medicine: 'style_reference',
      'context.dna_style_text': 'style_reference',
      dna_style_text: 'style_reference',
    });
  });
});

describe('the clinician’s DNA and the few-shot exemplars are DATA in style_reference', () => {
  it('carries the style, the redaction rules and the exemplars in one style_reference block, placed first', async () => {
    resolveBody('Write the note.');
    await (await getService({ exemplars: [{ redactedAfter: EXEMPLAR }] })).assemble({ ...base, dnaStyleId: 'dna-1', dnaRedactionRulesText: RULES });
    const blocks = composerInput().dataBlocks ?? [];

    expect(blocks[0]?.key).toBe('style_reference');
    expect(blocks[0]?.content).toContain(STYLE);
    expect(blocks[0]?.content).toContain(RULES);
    expect(blocks[0]?.content).toContain(EXEMPLAR);
    expect(blocks.filter((block) => block.key === 'style_reference')).toHaveLength(1);
  });

  it('states the static guidance for each part as a keyed contract part', async () => {
    resolveBody('Write the note.');
    await (await getService({ exemplars: [{ redactedAfter: EXEMPLAR }] })).assemble({ ...base, dnaStyleId: 'dna-1', dnaRedactionRulesText: RULES });
    const keys = (composerInput().outputContractParts ?? []).map((part) => part.key);
    expect(keys).toEqual(['style-reference-exemplars', 'dna-style', 'dna-redaction-rules']);
  });

  it('the static guidance is byte-identical for two different doctors and exemplar sets', async () => {
    resolveBody('Write the note.');
    await (await getService({ exemplars: [{ redactedAfter: EXEMPLAR }] })).assemble({ ...base, dnaStyleId: 'dna-1', dnaRedactionRulesText: RULES });
    const first = composerInput().outputContractParts;
    mockDnaWritingStyleRepository.findById.mockResolvedValue({ styleText: 'Another doctor entirely.' });
    await (await getService({ exemplars: [{ redactedAfter: 'other note' }] })).assemble({ ...base, dnaStyleId: 'dna-2', dnaRedactionRulesText: '- other rule' });
    expect(composerInput().outputContractParts).toEqual(first);
  });

  it('a body that places the style itself gets no duplicate guidance', async () => {
    resolveBody('Style: {{context.dna_style_text}}. Rules: {{context.dna_redaction_rules_text}}.');
    await (await getService()).assemble({ ...base, dnaStyleId: 'dna-1', dnaRedactionRulesText: RULES });
    const input = composerInput();
    expect((input.outputContractParts ?? []).map((part) => part.key)).toEqual([]);
    expect(input.blockAliases).toMatchObject({ 'context.dna_redaction_rules_text': 'style_reference' });
  });

  it('exposes the style_reference content for a note plan the assembly does not own', async () => {
    const content = await (await getService()).styleReference({ ...base, dnaStyleId: 'dna-1', dnaRedactionRulesText: RULES });
    expect(content).toContain(STYLE);
    expect(content).toContain(RULES);
    expect(await (await getService()).styleReference({ ...base })).toBeNull();
  });
});

describe('D9 — stable context first, the transcript last', () => {
  it('orders the transcript after every other data section', async () => {
    resolveBody('Body.');
    const assembled = await (await getService()).assemble({ ...base, clinicianNotes: ['[case note] review'], vitals: VITALS, previousVisits: PREVIOUS });
    expect(assembled.blocks?.map((block) => block.key)).toEqual(['clinician_notes', 'recent_vitals', 'previous_case_notes_summary', 'transcript']);
  });
});

describe('a composed note plan', () => {
  const NOTE_BLOCKS = [{ key: 'encounter_1', label: 'Encounter 1 transcript (New visit)', content: TRANSCRIPT }];

  it('binds the data variables EMPTY and points them at the note inputs — the plan’s blocks are the whole user message', async () => {
    resolveBody('Transcript:\n{{transcript}}\nVitals {{context.safe_vitals}}');
    await (await getService()).assemble({ ...base, vitals: VITALS, noteInputBlocks: NOTE_BLOCKS });
    const input = composerInput();
    const scope = input.scope as { transcript: string; context: Record<string, string> };

    expect(input.dataBlocks).toEqual(NOTE_BLOCKS);
    expect(scope.transcript).toBe('');
    expect(scope.context.safe_vitals).toBe('');
    expect(input.blockAliases).toMatchObject({ transcript: 'note_inputs', 'context.safe_vitals': 'note_inputs' });
    expect((input.outputContractParts ?? []).map((part) => part.key)).toContain('note-inputs');
    expect(systemSideText(input)).not.toContain(VITALS);
  });
});

describe('FC-2 / FC-4 — governance travels with the assembled prompt', () => {
  it('returns the composer’s governance and the platform pieces it emitted', async () => {
    const governance: SystemGovernance = { pieces: [{ kind: 'PLATFORM', key: 'platform-rules@1', digest: 'd1' }], composedDigest: 'c1' };
    const actual = (await vi.importActual<typeof import('@arcaai/workflow-contract')>('@arcaai/workflow-contract')).composeMessages;
    vi.mocked(composeMessages).mockImplementationOnce((input) => ({ ...actual(input), governance }));
    resolveBody('Body.');

    const assembled = await (await getService({ exemplars: [{ redactedAfter: EXEMPLAR }] })).assemble({ ...base });

    expect(assembled.governance).toEqual(governance);
    expect(assembled.platformPieces?.map((piece) => [piece.kind, piece.sourceKey])).toEqual([
      ['PLATFORM', expect.stringMatching(/^platform-rules@/)],
      ['LANGUAGE', 'language:English'],
      ['CONTRACT', 'style-reference-exemplars'],
    ]);
    expect(assembled.platformPieces?.[1]?.text).toBe(outputLanguageStep('English'));
  });
});

describe('a body that does not parse is still sent verbatim — as a keyed contract part', () => {
  it('keys it `template-body-verbatim`', async () => {
    resolveBody('Broken {{ body');
    await (await getService()).assemble({ ...base });
    const parts = composerInput().outputContractParts ?? [];
    expect(parts[0]).toEqual({ key: 'template-body-verbatim', text: 'Broken {{ body' });
  });
});
