/**
 * TASK-1050 finding D — the async pre-summary's TEXT call carries its guardrail attribution: the
 * serving agent (`agent_slug`), the consultation (`X-Hope-Consultation-Id`) and the CASE_NOTE items
 * placed in the `case_notes` region at their current version. Before, the evaluation had no
 * consultation (it rode only as the `known_phi` hint) and no agent.
 *
 * The REAL `TextRequestEnrichmentService` builds the body, so the assertion is on what TEXT receives.
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
    create: vi.fn().mockImplementation(async (entity: { content?: string }) => ({ id: 'ctx-1', content: entity.content })),
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
      findById: vi.fn().mockResolvedValue({ id: 'consult-1', tenantId: TENANT, departmentId: null, parentConsultationId: null, doctorId: 'd-1' }),
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
  return { processor, httpService };
}

describe('PreSummaryProcessor — guardrail attribution on the TEXT call', () => {
  it('names the agent, the consultation and the case-note items', async () => {
    const { processor, httpService } = buildProcessor();
    await processor.process({
      id: 'bull-1',
      timestamp: Date.now(),
      data: { jobId: 'job-1', consultationId: 'consult-1', tenantId: TENANT, userId: 'user-1', request: {} },
    } as never);

    const [, body, config] = httpService.axiosRef.post.mock.calls.at(-1)! as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(body.agent_slug).toBe('platform-summarization');
    expect(body.region_items).toEqual({
      case_notes: [
        { itemId: 'note-1', itemVersion: 2 },
        { itemId: 'note-3', itemVersion: 1 },
      ],
    });
    expect(config.headers['X-Hope-Consultation-Id']).toBe('consult-1');
  });
});
