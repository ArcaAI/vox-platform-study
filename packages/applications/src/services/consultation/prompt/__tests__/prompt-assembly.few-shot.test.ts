/**
 * PromptAssemblyService — per-department few-shot exemplars.
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
    { getEffectivePolicy: vi.fn().mockResolvedValue({ warmStartEnabled: false }) } as never,
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

  it('injects retrieved exemplars into the prompt', async () => {
    const { service } = await buildService({ exemplars: [exemplar('EXEMPLAR-ONE'), exemplar('EXEMPLAR-TWO')] });

    const { userPrompt } = await assemble(service as never);

    expect(userPrompt).toContain('EXEMPLAR-ONE');
    expect(userPrompt).toContain('EXEMPLAR-TWO');
  });

  it('retrieves for the caller tenant + department', async () => {
    const { service, retrieveExemplars } = await buildService({ exemplars: [exemplar('E')] });

    await assemble(service as never);

    expect(retrieveExemplars).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, departmentId: DEPARTMENT }));
  });

  it('places the exemplar block BEFORE the transcript (prefix-cache stability)', async () => {
    const { service } = await buildService({ exemplars: [exemplar('EXEMPLAR-ONE')] });

    const { userPrompt } = await assemble(service as never);

    expect(userPrompt.indexOf('EXEMPLAR-ONE')).toBeLessThan(userPrompt.indexOf('TRANSCRIPT-MARKER'));
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

  it('labels the block as style reference, not clinical content', async () => {
    // The model must not mistake another encounter's note for THIS patient's
    // history — that would be a fabrication vector.
    const { service } = await buildService({ exemplars: [exemplar('EXEMPLAR-ONE')] });

    const { userPrompt } = await assemble(service as never);
    const block = userPrompt.slice(0, userPrompt.indexOf('EXEMPLAR-ONE'));

    expect(block).toMatch(/different patient|not.*this patient|style/i);
  });
});
