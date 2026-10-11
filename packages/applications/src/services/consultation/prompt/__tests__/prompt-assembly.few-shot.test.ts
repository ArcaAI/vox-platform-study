/**
 * PromptAssemblyService — per-department few-shot exemplars.
 *
 * TASK-1061 OD-1 SUPERSEDES the injection below: a model copied another patient's facts from these
 * exemplars into a new patient's note, so NO prompt this assembly builds carries them any more (the
 * finalizer never did). What stays true: the prompt is byte-identical with or without a wired,
 * populated or broken retriever. Regression suite: `prompt-assembly.exemplar-leak.task1061.test.ts`.
 *
 * Original intent, for the record:
 *
 * The clinician approve-vs-edit signal now reaches the prompt: `APPROVED_CLEAN`
 * exemplars for the caller's department are injected as few-shot examples of the
 * house note style. Explicitly NOT fine-tuning.
 *
 * Two placement rules that carry real consequences:
 *
 *  1. **Inside the stable prefix region.** The exemplar block must sit with the
 *     template content, BEFORE the per-encounter transcript, so the engine's
 *     prefix cache still hits across flushes. Exemplar sets change infrequently
 *     (a mining job, not a request), so the prefix stays stable in practice.
 *  2. **Never at the cost of the generation.** No exemplars, a retrieval outage,
 *     or an unwired service must all degrade silently to today's zero-shot
 *     prompt — a learning-loop dependency must not become a generation
 *     dependency.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPromptResolutionService = { resolve: vi.fn() };
const mockPromptTemplateRepository = { findById: vi.fn() };
const mockDnaWritingStyleRepository = { findById: vi.fn() };

const TENANT = 'tenant-fewshot';
const DEPARTMENT = 'dept-1';

function createTemplate() {
  return {
    id: 'template-fewshot',
    name: 'FewShot',
    content: 'Summarize for {conversation_language}.',
    variables: { conversation_language: { type: 'string', required: true } },
    metaData: { promptConfig: { hyperparameters: {}, outputSchema: null } },
  };
}

const exemplar = (redactedAfter: string) => ({ redactedAfter, qualitySignal: 'APPROVED_CLEAN', tenantId: TENANT });

async function buildService(opts: { exemplars?: unknown[]; throws?: boolean; wired?: boolean } = {}) {
  const { PromptAssemblyService } = await import('../prompt-assembly.service');
  const retrieveExemplars = vi.fn(async () => {
    if (opts.throws) throw new Error('mining store down');
    return opts.exemplars ?? [];
  });
  const service = new PromptAssemblyService(
    mockPromptResolutionService as never,
    mockPromptTemplateRepository as never,
    mockDnaWritingStyleRepository as never,
    { get: vi.fn() } as never,
    (opts.wired ?? true) ? ({ retrieveExemplars } as never) : undefined,
  );
  return { service, retrieveExemplars };
}

const assemble = (service: { assemble: (p: unknown) => Promise<{ userPrompt: string }> }) =>
  service.assemble({
    tenantId: TENANT,
    departmentId: DEPARTMENT,
    promptType: 'new-patient',
    transcript: 'TRANSCRIPT-MARKER patient reports chest pain',
    conversationLanguage: 'en',
  });

describe('PromptAssemblyService — few-shot exemplars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPromptResolutionService.resolve.mockResolvedValue({ promptId: 'template-fewshot', resolvedFrom: 'default' });
    mockPromptTemplateRepository.findById.mockResolvedValue(createTemplate());
    mockDnaWritingStyleRepository.findById.mockResolvedValue(null);
  });

  it('TASK-1061 OD-1: never injects retrieved exemplars into the prompt', async () => {
    const { service } = await buildService({ exemplars: [exemplar('EXEMPLAR-ONE'), exemplar('EXEMPLAR-TWO')] });

    const { userPrompt } = await assemble(service as never);

    expect(userPrompt).not.toContain('EXEMPLAR-ONE');
    expect(userPrompt).not.toContain('EXEMPLAR-TWO');
  });

  it('TASK-1061 OD-1: never even reads the exemplar store', async () => {
    const { service, retrieveExemplars } = await buildService({ exemplars: [exemplar('E')] });

    await assemble(service as never);

    expect(retrieveExemplars).not.toHaveBeenCalled();
  });

  it('a populated store and an unwired one produce the same prompt', async () => {
    const populated = await buildService({ exemplars: [exemplar('EXEMPLAR-ONE')] });
    const unwired = await buildService({ wired: false });

    expect((await assemble(populated.service as never)).userPrompt).toBe((await assemble(unwired.service as never)).userPrompt);
  });

  it('adds NOTHING when there are no exemplars (byte-identical zero-shot prompt)', async () => {
    const withNone = await buildService({ exemplars: [] });
    const unwired = await buildService({ wired: false });

    const a = await assemble(withNone.service as never);
    const b = await assemble(unwired.service as never);

    expect(a.userPrompt).toBe(b.userPrompt);
    expect(a.userPrompt).not.toMatch(/example/i);
  });

  it('degrades to zero-shot when retrieval throws — never fails the generation', async () => {
    const broken = await buildService({ throws: true });
    const none = await buildService({ exemplars: [] });

    const a = await assemble(broken.service as never);
    const b = await assemble(none.service as never);

    expect(a.userPrompt).toBe(b.userPrompt);
  });

  it('carries no exemplar section label at all', async () => {
    // The old label ("APPROVED NOTES FROM DIFFERENT PATIENTS") did not stop a model copying them.
    const { service } = await buildService({ exemplars: [exemplar('EXEMPLAR-ONE')] });

    const { userPrompt, systemPrompt } = await assemble(service as never);

    expect(`${systemPrompt}\n${userPrompt}`).not.toMatch(/approved notes|different patients|note structure examples/i);
  });
});
