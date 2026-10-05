/**
 * TASK-1020 — assembly carries the same-day prequel and the client's lab results.
 *
 * Two variables, one seam (the shared entry point every non-live caller goes through):
 *
 *  - `same_day_prequel_summary` — the dated notes of the patient's EARLIER visits today. It was
 *    removed as dead once (zero producers); it has a producer now (`harness/same-day-prequel.ts`).
 *  - `formatted_test_results` — v1's ninth pre-summary placeholder, `''` on every prompt until the
 *    `investigations` kind gave it a source.
 *
 * Both follow the consumed-variable convention every other data block follows: a body that inlines
 * the value gets it in place and no duplicate; a body that does not gets a delimiter-wrapped data
 * block; and an absent value leaves the prompt byte-identical.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PLAIN_BODY = 'Write the note in {{context.conversation_language}}.';
const V1_BODY = ['- Tests: {{context.formatted_test_results}}', '- Language: {{context.language_name}}'].join('\n');

const PREQUEL = '### Earlier visit today (04:15 UTC, status APPROVED)\nMORNING-NOTE plan: CBC, LFT';
const RESULTS = '- Haemoglobin: 10.2 g/dL (ref 13-17) [L]';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn(), findByIdWithDecryptedFields: vi.fn() };
const mockDepartmentRepository = { findById: vi.fn() };

async function getService() {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  return new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    undefined,
    undefined,
    undefined,
    mockDepartmentRepository as never,
  );
}

const withBody = (content: string) =>
  mockPromptResolutionService.resolve.mockResolvedValue({
    template: 'body',
    promptId: 'template-1',
    content,
    resolvedFrom: 'tenant',
    resolutionTrace: { usedDefaults: [] },
  });

const base = { tenantId: 'tenant-1', promptType: 'revisit', transcript: 'afternoon transcript', conversationLanguage: 'en' };

beforeEach(() => {
  vi.clearAllMocks();
  withBody(PLAIN_BODY);
  mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'template-1', metaData: null });
  mockDepartmentRepository.findById.mockResolvedValue({ id: 'dept-1', name: 'Haematology' });
});

describe('TASK-1020 — same_day_prequel_summary', () => {
  it('points {{context.same_day_prequel_summary}} at its ONE data section', async () => {
    withBody('Earlier today:\n{{context.same_day_prequel_summary}}\n' + PLAIN_BODY);
    const service = await getService();

    const { userPrompt, systemPrompt } = await service.assemble({ ...base, sameDayPrequelSummary: PREQUEL });

    expect(systemPrompt).toContain('Earlier today:\n[see the SAME-DAY EARLIER VISIT(S) data section below]');
    expect(systemPrompt).not.toContain('MORNING-NOTE');
    expect(userPrompt.split('MORNING-NOTE').length - 1).toBe(1);
  });

  it('appends a SAME-DAY data block on a body that does not inline it', async () => {
    const service = await getService();

    const { userPrompt } = await service.assemble({ ...base, sameDayPrequelSummary: PREQUEL });

    expect(userPrompt).toContain(`<<<EXTERNAL_DATA section="same_day_prequel_summary">>>\n--- SAME-DAY EARLIER VISIT(S) ---\n${PREQUEL}`);
  });

  it('renders an empty value (never a literal placeholder, never a failure) when there is no prequel', async () => {
    withBody('Earlier today: [{{context.same_day_prequel_summary}}] ' + PLAIN_BODY);
    const service = await getService();

    const { userPrompt, systemPrompt } = await service.assemble({ ...base });

    expect(systemPrompt).toContain('Earlier today: [] ');
    expect(userPrompt).not.toContain('same_day_prequel_summary');
  });

  it('leaves the prompt byte-identical when no prequel is supplied', async () => {
    const service = await getService();

    const without = (await service.assemble({ ...base })).userPrompt;
    const withBlank = (await service.assemble({ ...base, sameDayPrequelSummary: '   ' })).userPrompt;

    expect(withBlank).toBe(without);
    expect(without).not.toContain('SAME-DAY');
  });
});

describe('TASK-1020 — formatted_test_results', () => {
  it('points v1’s {{context.formatted_test_results}} at the TEST RESULTS section built from the investigations kind', async () => {
    withBody(V1_BODY);
    const service = await getService();

    const { userPrompt, systemPrompt } = await service.assemble({ ...base, promptType: 'pre-summary', testResults: RESULTS });

    expect(systemPrompt).toContain('- Tests: [see the TEST RESULTS data section below]');
    expect(userPrompt.split('Haemoglobin').length - 1).toBe(1);
  });

  it('keeps v1’s own `` default when no results were sent', async () => {
    withBody(V1_BODY);
    const service = await getService();

    const { systemPrompt } = await service.assemble({ ...base, promptType: 'pre-summary' });

    expect(systemPrompt).toContain('- Tests: \n');
  });

  it('appends a TEST RESULTS data block on a body that inlines nothing', async () => {
    const service = await getService();

    const { userPrompt } = await service.assemble({ ...base, testResults: RESULTS });

    expect(userPrompt).toContain(`<<<EXTERNAL_DATA section="test_results">>>\n--- TEST RESULTS ---\n${RESULTS}`);
  });

  it('appends nothing when no results were sent', async () => {
    const service = await getService();

    const { userPrompt } = await service.assemble({ ...base });

    expect(userPrompt).not.toContain('test_results');
    expect(userPrompt).not.toContain('TEST RESULTS');
  });
});
