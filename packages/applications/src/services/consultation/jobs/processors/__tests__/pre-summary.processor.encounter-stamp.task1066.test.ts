/**
 * A pre-summary belongs to the encounter it was generated in: the PRE_SUMMARY the async processor
 * stores carries the consultation's current encounter.
 */
import { describe, expect, it, vi } from 'vitest';
import { PreSummaryProcessor } from '../pre-summary.processor';
import { TextRequestEnrichmentService } from '../../../../text-request/text-request-enrichment.service';

const TENANT = 'tenant-1';

function buildProcessor() {
  const contextItemRepository = {
    findByConsultation: vi.fn().mockResolvedValue([
      { id: 'note-1', content: 'Chest pain for three days.', currentVersionNumber: 2 },
      { id: 'note-empty', content: '   ', currentVersionNumber: 1 },
      { id: 'note-3', content: 'Smoker.', currentVersionNumber: 1 },
    ]),
    findById: vi.fn(),
    create: vi.fn().mockImplementation(async (entity: { content?: string }) => ({
      id: 'ctx-1',
      consultationId: 'consult-1',
      guardrailStatus: 'CLEAN',
      content: entity.content,
    })),
    setGuardrailStatus: vi.fn().mockResolvedValue(undefined),
    encryptContentIntoEntity: vi.fn(),
  };
  const httpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'PRE-SUMMARY' } }) } };
  const processor = new PreSummaryProcessor(
    {
      notifyProgress: vi.fn().mockResolvedValue(undefined),
      notifyComplete: vi.fn().mockResolvedValue(undefined),
      notifyFailed: vi.fn().mockResolvedValue(undefined),
    } as never,
    contextItemRepository as never,
    {
      findById: vi
        .fn()
        .mockResolvedValue({
          id: 'consult-1',
          tenantId: TENANT,
          departmentId: null,
          parentConsultationId: null,
          doctorId: 'd-1',
          currentEncounterSeq: 2,
        }),
    } as never,
    httpService as never,
    { get: vi.fn(() => 'http://text.test') } as never,
    { resolve: vi.fn().mockResolvedValue({ resolvedFrom: 'tenant', template: 'Pre-Summary', promptId: 'p1' }) } as never,
    {
      assemble: vi
        .fn()
        .mockResolvedValue({ userPrompt: 'assembled', systemPrompt: 'system', hyperparameters: {}, responseFormat: null, resolvedFrom: 'tenant' }),
    } as never,
    {
      recordJobStart: vi.fn(() => () => 1),
      recordWaitingDuration: vi.fn(),
      recordJobComplete: vi.fn(),
      recordJobFailed: vi.fn(),
      recordTextCallDuration: vi.fn(),
    } as never,
    { run: vi.fn(async (fn: () => Promise<unknown>) => fn()), set: vi.fn(), get: vi.fn() } as never,
    undefined,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'medgemma', agentSlug: 'platform-summarization' }) } as never,
    undefined,
    undefined,
    new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined) as never,
  );
  return { processor, httpService, contextItemRepository };
}

describe('PreSummaryProcessor — the encounter the pre-summary was written in', () => {
  it('stamps the PRE_SUMMARY with the consultation’s current encounter', async () => {
    const { processor, contextItemRepository } = buildProcessor();
    await processor.process({
      id: 'bull-1',
      timestamp: Date.now(),
      data: { jobId: 'job-1', consultationId: 'consult-1', tenantId: TENANT, userId: 'user-1', request: {} },
    } as never);

    const [created] = contextItemRepository.create.mock.calls[0] as unknown as [{ type: string; encounterSeq?: number | null }];
    expect(created.type).toBe('PRE_SUMMARY');
    expect(created.encounterSeq).toBe(2);
  });
});
