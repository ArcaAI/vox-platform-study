/**
 * TASK-635 C6 — the SECOND finalize path (`SummaryProcessor`, BullMQ
 * `JobQueue.GenerateSummary`) must behave exactly like `SummaryService` after
 * Wave 1 (A2/A3 — B-02/B-06) and C5 (R-N2 lineage):
 *
 *  - the warm-start pre-summary is read through the DECRYPTING, subType-aware
 *    accessor (`findLatestPreSummaryWithDecryptedContent`), filtering
 *    `LIVE_SOAP_SNAPSHOT` first with the legacy any-subType fallback;
 *  - the live session's frozen agent lineage (`metaData.agent`) is threaded
 *    into `PromptAssemblyService.assemble` as `preSummaryLineage` +
 *    `pinnedAgentId`, so the SAME agent that ran live finalizes (R-N2);
 *  - a consultation with no live session is byte-identical to pre-C6
 *    (both fields `undefined`).
 */

import { describe, it, expect, vi } from 'vitest';
import { Job } from 'bullmq';
import { SummaryProcessor } from '../processors/summary.processor';
import { GenerateSummaryJobPayload } from '../dto';

const createMockClsService = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((callback: () => unknown) => callback()),
    runWith: vi.fn((seed: Record<string, unknown>, callback: () => unknown) => {
      for (const [k, v] of Object.entries(seed)) store.set(k, v);
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
    has: vi.fn((key: string) => store.has(key)),
    isActive: vi.fn(() => true),
  };
};

const createMockJob = (data: GenerateSummaryJobPayload): Job<GenerateSummaryJobPayload> =>
  ({ data, id: data.jobId, name: 'generate', timestamp: Date.now() }) as unknown as Job<GenerateSummaryJobPayload>;

const LINEAGE = {
  agentId: 'agent-live-1',
  promptTemplateId: 'tpl-live-9',
  promptVersionNumber: 3,
};

/** Builds the processor with all collaborators mocked; returns the mocks used by assertions. */
const buildHarness = (preSummaryResult: { entity: unknown; plaintext: string | null }) => {
  const mockJobService = { notifyProgress: vi.fn(), notifyComplete: vi.fn(), notifyFailed: vi.fn() };
  const findLatestPreSummaryWithDecryptedContent = vi.fn().mockImplementation((_id: string, _secrets: unknown, options?: { subType?: string }) => {
    if (options?.subType === 'LIVE_SOAP_SNAPSHOT') {
      const entity = preSummaryResult.entity as { metaData?: { subType?: string } } | null;
      return Promise.resolve(entity?.metaData?.subType === 'LIVE_SOAP_SNAPSHOT' ? preSummaryResult : { entity: null, plaintext: null });
    }
    return Promise.resolve(preSummaryResult);
  });
  const mockContextItemRepository = {
    findById: vi.fn(),
    findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript text' }]),
    findLatestPreSummary: vi.fn().mockResolvedValue(null),
    findLatestPreSummaryWithDecryptedContent,
    create: vi.fn().mockResolvedValue({ id: 'sid', content: 'S' }),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
  };
  const mockConsultationRepository = { findById: vi.fn().mockResolvedValue({ id: 'consultation-123', tenantId: 'tenant-1' }) };
  const mockHttpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', modelName: 'm' } }) } };
  const mockConfigService = { get: vi.fn().mockImplementation((k: string) => (k === 'SMR_URL' ? 'http://localhost:8862' : undefined)) };
  const mockEventEmitter = { emit: vi.fn() };
  const mockPromptResolutionService = {
    resolve: vi.fn().mockResolvedValue({ template: 'SOAP', promptId: 'p', contextVariables: {}, resolvedFrom: 'default' }),
  };
  const mockPromptAssemblyService = {
    assemble: vi.fn().mockResolvedValue({ userPrompt: 'p', systemPrompt: '', hyperparameters: {}, responseFormat: null, resolvedFrom: 'default' }),
  };
  const mockJobMetrics = {
    recordJobStart: vi.fn().mockReturnValue(vi.fn()),
    recordJobComplete: vi.fn(),
    recordJobFailed: vi.fn(),
    recordWaitingDuration: vi.fn(),
    recordSmrCallDuration: vi.fn(),
  };
  const secretsStub = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') };

  const processor = new SummaryProcessor(
    mockJobService as never,
    mockContextItemRepository as never,
    mockConsultationRepository as never,
    mockHttpService as never,
    mockConfigService as never,
    mockEventEmitter as never,
    mockPromptResolutionService as never,
    mockPromptAssemblyService as never,
    mockJobMetrics as never,
    createMockClsService() as never,
    secretsStub as never,
  );

  return { processor, mockPromptAssemblyService, findLatestPreSummaryWithDecryptedContent, secretsStub };
};

const run = (processor: SummaryProcessor) =>
  processor.process(
    createMockJob({
      jobId: 'job-1',
      consultationId: 'consultation-123',
      tenantId: 'tenant-1',
      userId: 'user-1',
      request: {},
    } as unknown as GenerateSummaryJobPayload),
  );

describe('SummaryProcessor — warm-start decryption + R-N2 agent lineage (C6)', () => {
  it('reads the LIVE_SOAP_SNAPSHOT through the decrypting accessor and puts the DECRYPTED text in the prompt (B-02/B-06)', async () => {
    const { processor, mockPromptAssemblyService, findLatestPreSummaryWithDecryptedContent, secretsStub } = buildHarness({
      entity: { id: 'ctx-live-1', metaData: { subType: 'LIVE_SOAP_SNAPSHOT', agent: LINEAGE } },
      plaintext: 'DECRYPTED live SOAP note',
    });

    await run(processor);

    expect(findLatestPreSummaryWithDecryptedContent).toHaveBeenCalledWith('consultation-123', secretsStub, { subType: 'LIVE_SOAP_SNAPSHOT' });
    expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(expect.objectContaining({ preSummaryText: 'DECRYPTED live SOAP note' }));
  });

  it('threads the live agent lineage into assemble as preSummaryLineage + pinnedAgentId (R-N2)', async () => {
    const { processor, mockPromptAssemblyService } = buildHarness({
      entity: { id: 'ctx-live-1', metaData: { subType: 'LIVE_SOAP_SNAPSHOT', agent: LINEAGE } },
      plaintext: 'DECRYPTED live SOAP note',
    });

    await run(processor);

    expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        preSummaryLineage: expect.objectContaining({ agentId: 'agent-live-1', promptTemplateId: 'tpl-live-9', promptVersionNumber: 3 }),
        pinnedAgentId: 'agent-live-1',
      }),
    );
  });

  it('falls back to the latest pre-summary of ANY subType when no live snapshot exists (legacy path preserved)', async () => {
    const { processor, mockPromptAssemblyService, findLatestPreSummaryWithDecryptedContent, secretsStub } = buildHarness({
      entity: { id: 'ctx-case-notes', metaData: { subType: 'CASE_NOTES' } },
      plaintext: 'legacy case-notes pre-summary',
    });

    await run(processor);

    expect(findLatestPreSummaryWithDecryptedContent).toHaveBeenCalledWith('consultation-123', secretsStub, { subType: 'LIVE_SOAP_SNAPSHOT' });
    expect(findLatestPreSummaryWithDecryptedContent).toHaveBeenCalledWith('consultation-123', secretsStub);
    expect(mockPromptAssemblyService.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ preSummaryText: 'legacy case-notes pre-summary', preSummaryLineage: undefined, pinnedAgentId: undefined }),
    );
  });

  it('leaves both lineage fields undefined when the consultation never ran a live agent (additive-proof)', async () => {
    const { processor, mockPromptAssemblyService } = buildHarness({ entity: null, plaintext: null });

    await run(processor);

    const params = mockPromptAssemblyService.assemble.mock.calls[0][0];
    expect(params.preSummaryLineage).toBeUndefined();
    expect(params.pinnedAgentId).toBeUndefined();
    expect(params.preSummaryText).toBeUndefined();
  });
});
